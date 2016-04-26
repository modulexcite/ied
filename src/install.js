import crypto from 'crypto'
import path from 'path'
import {ArrayObservable} from 'rxjs/observable/ArrayObservable'
import {EmptyObservable} from 'rxjs/observable/EmptyObservable'
import {ScalarObservable} from 'rxjs/observable/ScalarObservable'
import {Observable} from 'rxjs/Observable'
import {_finally} from 'rxjs/operator/finally'
import {concat, concatStatic} from 'rxjs/operator/concat'
import {distinctKey} from 'rxjs/operator/distinctKey'
import {expand} from 'rxjs/operator/expand'
import {map} from 'rxjs/operator/map'
import {mergeMap} from 'rxjs/operator/mergeMap'
import needle from 'needle'

import * as cache from './cache'
import * as config from './config'
import * as registry from './registry'
import * as util from './util'
import * as progress from './progress'
import {normalizeBin, parseDependencies} from './pkg_json'

/**
 * properties of project-level `package.json` files that will be checked for
 * dependencies.
 * @type {Array.<String>}
 * @readonly
 */
export const ENTRY_DEPENDENCY_FIELDS = [
	'dependencies',
	'devDependencies',
	'optionalDependencies'
]

/**
 * properties of `package.json` of sub-dependencies that will be checked for
 * dependences.
 * @type {Array.<String>}
 * @readonly
 */
export const DEPENDENCY_FIELDS = [
	'dependencies',
	'optionalDependencies'
]

/**
 * initialize the `node_modules directory` in the current working directory.
 * @param  {String} cwd - current working directory.
 * @return {Observable} - observable sequence to be completed on success.
 */
export function initNodeModules (cwd) {
	return util.mkdirp(path.join(cwd, 'node_modules'))
}

/**
 * resolve a dependency's `package.json` file from the local file system.
 * @param  {String} nodeModules - `node_modules` base directory.
 * @param  {String} parentTarget - relative parent's node_modules path.
 * @param  {String} name - name of the dependency.
 * @return {Observable} - observable sequence of `package.json` objects.
 */
export function resolveFromNodeModules (nodeModules, parentTarget, name) {
	const linkname = path.join(nodeModules, parentTarget, 'node_modules', name)

	return util.readlink(linkname)::mergeMap((rel) => {
		const target = path.basename(rel)
		const filename = path.join(linkname, 'package.json')
		return util.readFileJSON(filename)::map((pkgJson) => ({
			parentTarget, pkgJson, target, name
		}))
	})
}

export function fetchFromRegistry () {
	const {target, pkgJson: {dist: {shasum, tarball}}} = this
	const o = cache.extract(target, shasum)
	return o::util.catchByCode({
		ENOENT: () => download(tarball, shasum)::concat(o)
	})
}

export function resolveFromRegistry (nodeModules, parentTarget, name, version) {
	return registry.match(name, version)::map((pkgJson) => {
		const target = pkgJson.dist.shasum
		return { parentTarget, pkgJson, target, name }
	})
}

/**
 * resolve an individual sub-dependency based on the parent's target and the
 * current working directory.
 * @param  {String} nodeModules - `node_modules` base directory.
 * @param  {String} parentTarget - target path used for determining the sub-
 * dependency's path.
 * @return {Obserable} - observable sequence of `package.json` root documents
 * wrapped into dependency objects representing the resolved sub-dependency.
 */
export function resolve (nodeModules, parentTarget) {
	return this::mergeMap(([name, version]) => {
		progress.add()
		progress.report(`resolving ${name}@${version}`)

		return resolveFromNodeModules(nodeModules, parentTarget, name)
			::util.catchByCode({
				ENOENT: () => resolveFromRegistry(nodeModules, parentTarget, name, version)
			})
			::_finally(progress.complete)
	})
}

/**
 * resolve all dependencies starting at the current working directory.
 * @param  {String} nodeModules - `node_modules` base directory.
 * @param  {Object} [targets=Object.create(null)] - resolved / active targets.
 * @return {Observable} - an observable sequence of resolved dependencies.
 */
export function resolveAll (nodeModules, targets = Object.create(null)) {
	return this::expand(({target, pkgJson}) => {
		// cancel when we get into a circular dependency
		if (target in targets) {
			return EmptyObservable.create()
		}

		targets[target] = true

		// install devDependencies of entry dependency (project-level)
		const fields = target === '..'
			? ENTRY_DEPENDENCY_FIELDS
			: DEPENDENCY_FIELDS

		const dependencies = parseDependencies(pkgJson, fields)

		return ArrayObservable.create(dependencies)
			::resolve(nodeModules, target)
	})
}

function resolveSymlink (src, dst) {
	return [ path.relative(path.dirname(dst), src), dst ]
}

function getBinLinks (nodeModules, pkgJson, parentTarget, target, name) {
	const binLinks = []
	const bin = normalizeBin(pkgJson)
	const names = Object.keys(bin)
	for (let i = 0; i < names.length; i++) {
		const name = names[i]
		const dst = path.join(nodeModules, parentTarget, 'node_modules', '.bin', name)
		const src = path.join(nodeModules, target, bin[name])
		binLinks.push(resolveSymlink(src, dst))
	}
	return binLinks
}

function getDirectLink (nodeModules, parentTarget, target, name) {
	const dst = path.join(nodeModules, target)
	const src = path.join(nodeModules, parentTarget, 'node_modules', name)
	return resolveSymlink(dst, src)
}

/**
 * symlink the intermediate results of the underlying observable sequence
 * @param  {String} nodeModules - `node_modules` base directory.
 * @return {Observable} - empty observable sequence that will be completed
 * once all dependencies have been symlinked.
 */
export function linkAll (nodeModules) {
	return this::mergeMap(({ pkgJson, parentTarget, target, name }) => {
		const binLinks = getBinLinks(nodeModules, pkgJson, parentTarget, target, name)
		const directLink = getDirectLink(nodeModules, parentTarget, target, name)

		progress.add()
		return concatStatic(binLinks, [directLink])
			::mergeMap(([src, dst]) => util.forceSymlink(src, dst))
			::_finally(progress.complete)
	})
}

export class CorruptedPackageError extends Error {
	/**
	 * create instance.
	 * @param  {String} tarball  - tarball url from which the corresponding
	 * tarball has been downloaded.
	 * @param  {String} expected - expected shasum.
	 * @param  {String} actual   - actual shasum.
	 */
	constructor (tarball, expected, actual) {
		super(`shasum mismatch while downloading ${tarball}: ${actual} <-> ${expected}`)
		this.name = 'CorruptedPackageError'
		this.tarball = tarball
		this.expected = expected
		this.actual = actual
	}
}

function download (tarball, expectedShasum) {
	return Observable.create((observer) => {
		const errorHandler = (error) => observer.error(error)
		const dataHandler = (chunk) => shasum.update(chunk)
		const finishHandler = () => {
			const actualShasum = shasum.digest('hex')
			observer.next({ tmpPath: cached.path, shasum: actualShasum })
			observer.complete()
		}

		const shasum = crypto.createHash('sha1')
		const response = needle.get(tarball, config.httpOptions)
		const cached = response.pipe(cache.write())

		response.on('data', dataHandler)
		response.on('error', errorHandler)

		cached.on('error', errorHandler)
		cached.on('finish', finishHandler)
	})
	::mergeMap(({ tmpPath, shasum }) => {
		if (expectedShasum && expectedShasum !== shasum) {
			throw new CorruptedPackageError(tarball, expectedShasum, shasum)
		}

		const newPath = path.join(config.cacheDir, shasum)
		return util.rename(tmpPath, newPath)
	})
}

function fixPermissions (target, bin) {
	const execMode = parseInt('0777', 8) & (~process.umask())
	const paths = []
	const names = Object.keys(bin)
	for (let i = 0; i < names.length; i++) {
		const name = names[i]
		paths.push(path.resolve(target, bin[name]))
	}
	return ArrayObservable.create(paths)
		::mergeMap((path) => util.chmod(path, execMode))
}

function fetch (nodeModules, {target, pkgJson: {name, bin, dist: {tarball, shasum} }}) {
	const where = path.join(nodeModules, target)
	const o = cache.extract(where, shasum)

	progress.add()
	return util.stat(where)
		::util.catchByCode({ ENOENT: () => o })
		::util.catchByCode({ ENOENT: () => download(tarball, shasum)
			::concat(o)
			::concat(fixPermissions(where, normalizeBin({ name, bin })))
		})
		::map((stat) => EmptyObservable.create())
		::_finally(progress.complete)
}

/**
 * download the tarballs into their respective `target`.
 * @return {Observable} - empty observable sequence that will be completed
 * once all dependencies have been downloaded.
 */
export function fetchAll (nodeModules) {
	return this
		::distinctKey('target')
		::mergeMap(fetch.bind(null, nodeModules))
}

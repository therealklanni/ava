'use strict';
var EventEmitter = require('events').EventEmitter;
var path = require('path');
var util = require('util');
var fs = require('fs');
var flatten = require('arr-flatten');
var Promise = require('bluebird');
var figures = require('figures');
var globby = require('globby');
var chalk = require('chalk');
var objectAssign = require('object-assign');
var commonPathPrefix = require('common-path-prefix');
var resolveCwd = require('resolve-cwd');
var uniqueTempDir = require('unique-temp-dir');
var findCacheDir = require('find-cache-dir');
var AvaError = require('./lib/ava-error');
var fork = require('./lib/fork');
var formatter = require('./lib/enhance-assert').formatter();
var CachingPrecompiler = require('./lib/caching-precompiler');

function Api(files, options) {
	if (!(this instanceof Api)) {
		throw new TypeError('Class constructor Api cannot be invoked without \'new\'');
	}

	EventEmitter.call(this);

	this.options = options || {};
	this.options.require = (this.options.require || []).map(resolveCwd);

	if (!files || files.length === 0) {
		this.files = [
			'test.js',
			'test-*.js',
			'test'
		];
	} else {
		this.files = files;
	}

	this.excludePatterns = [
		'!**/node_modules/**',
		'!**/fixtures/**',
		'!**/helpers/**'
	];

	Object.keys(Api.prototype).forEach(function (key) {
		this[key] = this[key].bind(this);
	}, this);

	this._reset();
}

util.inherits(Api, EventEmitter);
module.exports = Api;

Api.prototype._reset = function () {
	this.rejectionCount = 0;
	this.exceptionCount = 0;
	this.passCount = 0;
	this.skipCount = 0;
	this.failCount = 0;
	this.fileCount = 0;
	this.testCount = 0;
	this.errors = [];
	this.stats = [];
	this.tests = [];
	this.base = '';
	this.explicitTitles = false;
};

Api.prototype._runFile = function (file) {
	var options = objectAssign({}, this.options, {
		precompiled: this.precompiler.generateHashForFile(file)
	});

	return fork(file, options)
		.on('stats', this._handleStats)
		.on('test', this._handleTest)
		.on('unhandledRejections', this._handleRejections)
		.on('uncaughtException', this._handleExceptions)
		.on('stdout', this._handleOutput.bind(this, 'stdout'))
		.on('stderr', this._handleOutput.bind(this, 'stderr'));
};

Api.prototype._handleOutput = function (channel, data) {
	this.emit(channel, data);
};

Api.prototype._handleRejections = function (data) {
	this.rejectionCount += data.rejections.length;

	data.rejections.forEach(function (err) {
		err.type = 'rejection';
		err.file = data.file;
		this.emit('error', err);
		this.errors.push(err);
	}, this);
};

Api.prototype._handleExceptions = function (data) {
	this.exceptionCount++;
	var err = data.exception;
	err.type = 'exception';
	err.file = data.file;
	this.emit('error', err);
	this.errors.push(err);
};

Api.prototype._handleStats = function (stats) {
	this.testCount += stats.testCount;
};

Api.prototype._handleTest = function (test) {
	test.title = this._prefixTitle(test.file) + test.title;

	if (test.error) {
		if (test.error.powerAssertContext) {
			var message = formatter(test.error.powerAssertContext);

			if (test.error.originalMessage) {
				message = test.error.originalMessage + ' ' + message;
			}

			test.error.message = message;
		}

		if (test.error.name !== 'AssertionError') {
			test.error.message = 'failed with "' + test.error.message + '"';
		}

		this.errors.push(test);
	}

	this.emit('test', test);
};

Api.prototype._prefixTitle = function (file) {
	if (this.fileCount === 1 && !this.explicitTitles) {
		return '';
	}

	var separator = ' ' + chalk.gray.dim(figures.pointerSmall) + ' ';

	var prefix = path.relative('.', file)
		.replace(this.base, '')
		.replace(/\.spec/, '')
		.replace(/\.test/, '')
		.replace(/test\-/g, '')
		.replace(/\.js$/, '')
		.split(path.sep)
		.join(separator);

	if (prefix.length > 0) {
		prefix += separator;
	}

	return prefix;
};

Api.prototype.run = function (files) {
	var self = this;

	this._reset();
	this.explicitTitles = Boolean(files);
	return handlePaths(files || this.files, this.excludePatterns)
		.map(function (file) {
			return path.resolve(file);
		})
		.then(function (files) {
			if (files.length === 0) {
				self._handleExceptions({
					exception: new AvaError('Couldn\'t find any files to test'),
					file: undefined
				});

				return [];
			}

			var cacheEnabled = self.options.cacheEnabled !== false;
			var cacheDir = (cacheEnabled && findCacheDir({name: 'ava', files: files})) ||
				uniqueTempDir();

			self.options.cacheDir = cacheDir;
			self.precompiler = new CachingPrecompiler(cacheDir);
			self.fileCount = files.length;
			self.base = path.relative('.', commonPathPrefix(files)) + path.sep;

			var tests = files.map(self._runFile);

			// receive test count from all files and then run the tests
			var statsCount = 0;

			return new Promise(function (resolve) {
				tests.forEach(function (test) {
					var counted = false;

					function tryRun() {
						if (counted) {
							return;
						}

						if (++statsCount === self.fileCount) {
							self.emit('ready');

							var method = self.options.serial ? 'mapSeries' : 'map';

							resolve(Promise[method](files, function (file, index) {
								return tests[index].run().catch(function (err) {
									// The test failed catastrophically. Flag it up as an
									// exception, then return an empty result. Other tests may
									// continue to run.
									self._handleExceptions({
										exception: err,
										file: file
									});

									return {
										stats: {passCount: 0, skipCount: 0, failCount: 0},
										tests: []
									};
								});
							}));
						}
					}

					test.on('stats', tryRun);
					test.catch(tryRun);
				});
			});
		})
		.then(function (results) {
			// assemble stats from all tests
			self.stats = results.map(function (result) {
				return result.stats;
			});

			self.tests = results.map(function (result) {
				return result.tests;
			});

			self.tests = flatten(self.tests);

			self.passCount = sum(self.stats, 'passCount');
			self.skipCount = sum(self.stats, 'skipCount');
			self.failCount = sum(self.stats, 'failCount');
		});
};

function handlePaths(files, excludePatterns) {
	// convert pinkie-promise to Bluebird promise
	files = Promise.resolve(globby(files.concat(excludePatterns)));

	return files
		.map(function (file) {
			if (fs.statSync(file).isDirectory()) {
				return handlePaths([path.join(file, '**', '*.js')], excludePatterns);
			}

			return file;
		})
		.then(flatten)
		.filter(function (file) {
			return path.extname(file) === '.js' && path.basename(file)[0] !== '_';
		});
}

function sum(arr, key) {
	var result = 0;

	arr.forEach(function (item) {
		result += item[key];
	});

	return result;
}

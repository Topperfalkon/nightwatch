/**
 * Module dependencies
 */
var path = require('path');
var fs = require('fs');
var util = require('util');
var mkpath = require('mkpath');
var minimatch = require('minimatch');
var Nightwatch = require('../index.js');
var Logger = require('../lib/logger.js');

module.exports = new (function() {
  var globalResults = {
    passed : 0,
    failed : 0,
    errors : 0,
    skipped : 0,
    tests : 0,
    errmessages : [],
    modules : {}
  };

  function runModule(module, opts, moduleName, callback, finishCallback) {
    var client;
    try {
      client = Nightwatch.client(opts);
    } catch (err) {
      console.log(err.stack);
      finishCallback(err, false);
      return;
    }
    var keys = Object.keys(module);
    var setUp;
    var tearDown;
    var testResults = {
      passed : 0,
      failed : 0,
      errors : 0,
      skipped : 0,
      tests : 0,
      steps : keys.slice(0)
    };

    module.client = client.api;

    if (module.disabled === true) {
      console.log('\nSkipping module: ', Logger.colors.cyan(moduleName));
      callback(null, false);
      return;
    }

    function startClient(context, clientFn, client, onComplete) {
      client.once('nightwatch:finished', function(results, errors) {
        onComplete(results, errors);
      });
      clientFn.call(context, context.client);
      client.start();
    }

    // handling asynchronous setUp/tearDown case:
    // 1) if setUp/tearDown is defined with only one arg run it synchronously
    // 2) if setUp/tearDown is defined with two args, assume the second one to be the callback
    //    and pass the callbackFn as the second arg to be called from the async operation
    if (keys.indexOf('setUp') > -1) {
      setUp = function(context, clientFn) {
        if (module.setUp.length <= 1) {
          module.setUp.call(context, context.client);
          clientFn();
        } else if (module.setUp.length >= 1) {
          module.setUp.call(context, context.client, clientFn);
        }
      };
      keys.splice(keys.indexOf('setUp'), 1);
      testResults.steps.splice(testResults.steps.indexOf('setUp'), 1);
    } else {
      setUp = function(context, cb) {
        cb();
      };
    }

    if (typeof module.tearDown == 'function') {
      tearDown = function(context, clientFn, client, onComplete) {
        if (module.tearDown.length === 0) {
          startClient(context, clientFn, client, function(results, errors) {
            module.tearDown();
            onComplete(results, errors);
          });
        } else if (module.tearDown.length >= 0) {
          startClient(context, clientFn, client, function(results, errors) {
            module.tearDown(function() {
              onComplete(results, errors);
            });
          });
        }
      };
      keys.splice(keys.indexOf('tearDown'), 1);
      testResults.steps.splice(testResults.steps.indexOf('tearDown'), 1);
    } else {
      tearDown = startClient;
    }

    function next() {
      if (keys.length) {
        var key = keys.shift();
        if (typeof module[key] != 'function') {
          next();
          return;
        }

        var onTestFinished = function (results, errors) {
          client.printResult();
          globalResults.modules[moduleName][key] = {
            passed  : results.passed,
            failed  : results.failed,
            errors  : results.errors,
            skipped : results.skipped,
            tests   : [].concat(results.tests)
          };

          if (Array.isArray(errors) && errors.length) {
            globalResults.errmessages = globalResults.errmessages.concat(errors);
          }

          testResults.passed += results.passed;
          testResults.failed += results.failed;
          testResults.errors += results.errors;
          testResults.skipped += results.skipped;
          testResults.tests += results.tests.length;
          if (client.terminated) {
            callback(null, testResults, keys);
          } else {
            setTimeout(next, 0);
          }
        };

        console.log('\nRunning: ', Logger.colors.green(key));
        var test = wrapTest(setUp, tearDown, module[key], module, onTestFinished, client);
        var error = false;
        try {
          test(client.api);
        } catch (err) {
          globalResults.errmessages.push(err.message);
          console.log(Logger.colors.red('\nAn error occured while running the test:'));
          console.log(err.stack);
          testResults.errors++;
          client.terminate();
          error = true;
          callback(err, testResults);
        }
      } else {
        callback(null, testResults);
      }
    }

    setTimeout(next, 0);
  }

  function printResults(testresults, modulekeys) {
    if (testresults.passed > 0 && testresults.errors === 0 && testresults.failed === 0) {
      console.log(Logger.colors.green('\nOK. ' + testresults.passed, Logger.colors.background.black), 'total assertions passed.');
    } else {
      var skipped = '';
      if (testresults.skipped) {
        skipped = ' and ' + Logger.colors.cyan(testresults.skipped) + ' skipped.';
      }
      if (modulekeys && modulekeys.length) {
        modulekeys = modulekeys.map(function(e) {
          return Logger.colors.cyan('"' + e + '"');
        });
        var plural = modulekeys.length > 1 ? 's' : '';
        skipped += '\nStep' + plural + ' ' + modulekeys.join(', ') + ' skipped.';
      }
      console.log(Logger.colors.light_red('\nTEST FAILURE:'), Logger.colors.red(testresults.errors + testresults.failed) +
        ' assertions failed, ' + Logger.colors.green(testresults.passed) + ' passed' + skipped);
    }
  }

  function processExitListener() {
    process.on('exit', function(code) {
      if (globalResults.errors > 0 || globalResults.failed > 0) {
        process.exit(1);
      } else {
        process.exit(code);
      }
    });
  }

  function wrapTest(setUp, tearDown, testFn, context, onComplete, client) {
    return function (api) {
      context.client = api;

      var clientFn = function() {
        return tearDown(context, testFn, client, onComplete);
      };

      setUp(context, clientFn);
    };
  }

  function runFiles(paths, cb, opts) {
    var extensionPattern = /\.js$/;
    if (paths.length == 1 && extensionPattern.test(paths[0])) {
      paths[0] = paths[0].replace(extensionPattern, '');
      return cb(null, paths);
    }

    paths.forEach(function(p) {
      walk(p, function(err, list) {
        if (err) {
          return cb(err);
        }
        list.sort();

        var modules = list.filter(function (filePath) {
          var filename = filePath.split(path.sep).slice(-1)[0];
          return opts.filter ?
            minimatch(filename, opts.filter) :
            extensionPattern.exec(filePath);
        });

        modules = modules.map(function (filename) {
          return filename.replace(extensionPattern, '');
        });

        cb(null, modules);
      }, opts);
    });
  }

  function walk(dir, done, opts) {
    var results = [];
    fs.readdir(dir, function(err, list) {
      if (err) {
        return done(err);
      }
      var pending = list.length;

      if (pending === 0) {
        return done(null, results);
      }

      list.forEach(function(file) {
        file = [dir, file].join(path.sep);

        fs.stat(file, function(err, stat) {
          if (stat && stat.isDirectory()) {
            var dirName = file.split(path.sep).slice(-1)[0];
            if (opts.skipgroup && opts.skipgroup.indexOf(dirName) > -1) {
              pending = pending-1;
            } else {
              walk(file, function(err, res) {
                results = results.concat(res);
                pending = pending-1;
                if (!pending) {
                  done(null, results);
                }
              }, opts);
            }
          } else {
            results.push(file);
            pending = pending-1;

            if (!pending) {
              done(null, results);
            }
          }
        });
      });
    });
  }

  /**
   * Get any subfolders relative to the base module path so that we can save the report files into their corresponding subfolders
   *
   * @param {string} modulePath
   * @param {object} aditional_opts
   * @returns {string}
   */
  function getPathDiff(modulePath, aditional_opts) {
    var pathParts = modulePath.split(path.sep);
    pathParts.pop();

    var moduleFolder = pathParts.join(path.sep);
    var diffInFolder = '', srcFolder;

    if (Array.isArray(aditional_opts.src_folders)) {
      for (var i = 0; i < aditional_opts.src_folders.length; i++) {
        srcFolder = path.resolve(aditional_opts.src_folders[i]);
        if (moduleFolder.indexOf(srcFolder) === 0) {
          diffInFolder = moduleFolder.substring(srcFolder.length);
          break;
        }
      }
    } else if (typeof aditional_opts.src_folders == 'string') {
      if (moduleFolder.indexOf(aditional_opts.src_folders) === 0) {
        diffInFolder = moduleFolder.substring(aditional_opts.src_folders.length);
      }
    }
    return diffInFolder;
  }

  this.run = function runner(files, opts, aditional_opts, finishCallback) {
    var paths;
    finishCallback = finishCallback || function() {};

    if (typeof files == 'string') {
      paths = [files];
    } else {
      paths = files.map(function (p) {
        if (p.indexOf(process.cwd()) === 0) {
          return p;
        }
        return path.join(process.cwd(), p);
      });
    }

    if (paths.length === 0) {
      throw new Error('No tests to run.');
    }
    runFiles(paths, function runTestModule(err, fullpaths) {
      if (!fullpaths || fullpaths.length === 0) {
        finishCallback({message: 'No tests defined! using source folder ' + paths});
        return;
      }

      var module;
      var modulePath = fullpaths.shift();
      try {
        module = require(modulePath);
      } catch (err) {
        finishCallback(err);
        throw err;
      }

      var moduleName = modulePath.split(path.sep).pop();
      globalResults.modules[moduleName] = [];
      console.log('\n' + Logger.colors.cyan('[ ' + moduleName + ' module ]'));

      runModule(module, opts, moduleName, function(err, testresults, modulekeys) {
        if (typeof testresults == 'object') {
          globalResults.passed += testresults.passed;
          globalResults.failed += testresults.failed;
          globalResults.errors += testresults.errors;
          globalResults.skipped += testresults.skipped;
          globalResults.tests += testresults.tests;
        }

        if (fullpaths.length) {
          setTimeout(function() {
            runTestModule(err, fullpaths);
          }, 0);
        } else {
          if (testresults.tests != globalResults.tests || testresults.steps.length > 1) {
            printResults(globalResults, modulekeys);
          }

          if (aditional_opts.output_folder === false) {
            finishCallback(null, globalResults, modulekeys);
          } else {
            var diffInFolder = getPathDiff(modulePath, aditional_opts);
            var output = path.join(aditional_opts.output_folder, diffInFolder);
            mkpath(output, function(err) {
              if (err) {
                console.log(Logger.colors.yellow('Output folder doesn\'t exist and cannot be created.'));
                console.log(err.stack);
                finishCallback(null);
                return;
              }

              var Reporter = require('./reporters/junit.js');
              Reporter.save(globalResults, output, function(err) {
                if (err) {
                  console.log(Logger.colors.yellow('Warning: Failed to save report file to folder: ' + output));
                  console.log(err.stack);
                }
                finishCallback(null);
              });
            });
          }
        }
      }, finishCallback);
    }, opts);

    processExitListener();
  };
})();

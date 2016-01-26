'use strict';

var core = require('kartotherian-core');
var util = require('util');
var sUtil = require('../lib/util');
var pathLib = require('path');
var BBPromise = require('bluebird');
var _ = require('underscore');
var express = require('express');

var Err;
var app, sources;
var metrics;

var infoHeaders = {};

function reportError(errReporterFunc, err) {
    try {
        errReporterFunc(err);
    } catch (e2) {
        console.error('Unable to report: ' + core.errToStr(err) + '\n\nDue to: ' + core.errToStr(e2));
    }
}

function reportRequestError(err, res) {
    reportError(function (err) {
        res
            .status(400)
            .header('Cache-Control', 'public, s-maxage=30, max-age=30')
            .json(err.message || 'error/unknown');
        core.log('error', err);
        metrics.increment(err.metrics || 'err.unknown');
    }, err);
}

function filterJson(query, data) {
    if ('summary' in query) {
        data = _(data).reduce(function (memo, layer) {
            memo[layer.name] = {
                features: layer.features.length,
                jsonsize: JSON.stringify(layer).length
            };
            return memo;
        }, {});
    } else if ('nogeo' in query) {
        // Recursively remove all "geometry" fields, replacing them with geometry's size
        var filter = function (val, key) {
            if (key === 'geometry') {
                return val.length;
            } else if (_.isArray(val)) {
                return _.map(val, filter);
            } else if (_.isObject(val)) {
                _.each(val, function (v, k) {
                    val[k] = filter(v, k);
                });
            }
            return val;
        };
        data = _.map(data, filter);
    }
    return data;
}

/**
 * Web server (express) route handler to get requested tile or info
 * @param req request object
 * @param res response object
 * @param next will be called if request is not handled
 */
function requestHandler(req, res, next) {

    var start = Date.now();
    // These vars might get set before finishing validation.
    // Do not use them unless successful
    var isStatic, srcId, source, opts, z, x, y, scale, format, handler;

    return BBPromise.try(function () {
        if (!sources) {
            throw new Err('The service has not started yet');
        }

        srcId = req.params.src;
        source = sources.getSourceById(srcId, true);
        if (!source) {
            throw new Err('Unknown source').metrics('err.req.source');
        }
        if (!source.public) {
            throw new Err('Source is not public').metrics('err.req.source');
        }

        var isInfoRequest = false;
        if (req.params.info) {
            if (req.params.info === 'pbfinfo' || req.params.info === 'info') {
                isInfoRequest = true;
                format = 'json';
            } else {
                throw new Err('Unexpected info type').metrics('err.req.info');
            }
        } else {
            format = req.params.format;
        }
        if (!isInfoRequest && format !== 'pbf' && !_.contains(source.formats, format)) {
            throw new Err('Format %s is not known', format).metrics('err.req.format');
        }
        if (format === 'pbf' || req.params.info === 'pbfinfo') {
            if (!source.pbfsource) {
                throw new Err('pbf access is not enabled for this source').metrics('err.req.pbf');
            }
            var pbfSrcId = source.pbfsource;
            source = sources.getSourceById(pbfSrcId);
            handler = sources.getHandlerById(pbfSrcId, true);
        } else {
            handler = sources.getHandlerById(srcId, true);
        }
        if (!handler) {
            throw new Err('The source has not started yet').metrics('err.req.source');
        }
        if (isInfoRequest) {
            return handler.getInfoAsync().then(function(info) {
                return [info, infoHeaders];
            });
        }

        z = core.strToInt(req.params.z);
        if (!core.isValidZoom(z)) {
            throw new Err('invalid zoom').metrics('err.req.coords');
        }
        if (source.minzoom !== undefined && z < source.minzoom) {
            throw new Err('Minimum zoom is %d', source.minzoom).metrics('err.req.zoom');
        }
        if (source.maxzoom !== undefined && z > source.maxzoom) {
            throw new Err('Maximum zoom is %d', source.maxzoom).metrics('err.req.zoom');
        }
        scale = req.params.scale;
        if (scale !== undefined) {
            if (!source.scales) {
                throw new Err('Scaling is not enabled for this source').metrics('err.req.scale');
            }
            if (!_.contains(source.scales, scale.toString())) {
                throw new Err('This scaling is not allowed for this source. Allowed: %s', source.scales.join())
                    .metrics('err.req.scale');
            }
            scale = parseFloat(scale);
        }

        x = core.strToInt(req.params.x);
        y = core.strToInt(req.params.y);
        if (!core.isValidCoordinate(x, z) || !core.isValidCoordinate(y, z)) {
            throw new Err('x,y coordinates are not valid, or not allowed for this zoom').metrics('err.req.coords');
        }
        if (format !== 'pbf') {
          opts = {format: format};
          if (scale) {
              opts.scale = scale;
          }
        }
        return core.getTitleWithParamsAsync(handler, z, x, y, opts);
    }).spread(function (data, dataHeaders) {
        if (app.conf.defaultHeaders) res.set(app.conf.defaultHeaders);
        if (source.defaultHeaders) res.set(source.defaultHeaders);
        if (dataHeaders) res.set(dataHeaders);
        if (app.conf.overrideHeaders) res.set(app.conf.overrideHeaders);
        if (source.headers) res.set(source.headers);

        if (format === 'json') {
            // Allow JSON to be shortened to simplify debugging
            res.json(filterJson(req.query, data));
        } else {
            res.send(data);
        }

        var mx = util.format('req.%s.%s', srcId, z);
        mx += '.' + format;
        if (isStatic) {
            mx += '.static';
        }
        if (scale) {
            // replace '.' with ',' -- otherwise grafana treats it as a divider
            mx += '.' + (scale.toString().replace('.', ','));
        }
        metrics.endTiming(mx, start);
    }).catch(function(err) {
        return reportRequestError(err, res);
    }).catch(next);
}

function init(opts) {
    Err = core.Err;
    app = opts.app;
    sources = opts.sources;
    metrics = app.metrics;

    var staticOpts = {};
    staticOpts.index = false;
    staticOpts.setHeaders = function (res) {
        if (app.conf.cache) {
            res.header('Cache-Control', app.conf.cache);
        }
        if (res.req.originalUrl.endsWith('.pbf')) {
            res.header('Content-Encoding', 'gzip');
        }
    };

    var router = sUtil.router();

    // get tile
    router.get('/:src(' + core.Sources.sourceIdReStr + ')/:z(\\d+)/:x(\\d+)/:y(\\d+).:format([\\w]+)', requestHandler);
    router.get('/:src(' + core.Sources.sourceIdReStr + ')/:z(\\d+)/:x(\\d+)/:y(\\d+)@:scale([\\.\\d]+)x.:format([\\w]+)', requestHandler);

    // get source info (json)
    router.get('/:src(' + core.Sources.sourceIdReStr + ')/:info(pbfinfo).json', requestHandler);
    router.get('/:src(' + core.Sources.sourceIdReStr + ')/:info(info).json', requestHandler);

    // get preview map
    router.get('/preview', function(req, res) { res.sendFile('preview.html', {root: 'static'}); });

    // Add before static to prevent disk IO on each tile request
    app.use('/', router);
    app.use('/', express.static(pathLib.resolve(__dirname, '../static'), staticOpts));
    app.use('/leaflet', express.static(pathLib.dirname(require.resolve('leaflet')), staticOpts));

    metrics.increment('init');
};

module.exports = function(app) {

    return BBPromise.try(function () {
        core.init(app.logger, pathLib.resolve(__dirname, '..'), function (module) {
            return require.resolve(module);
        }, require('tilelive'), require('mapnik'));

        core.registerSourceLibs(
            require('tilelive-bridge'),
            require('tilelive-vector'),
            require('kartotherian-autogen'),
            require('kartotherian-demultiplexer'),
            require('kartotherian-overzoom'),
            require('kartotherian-cassandra'),
            require('kartotherian-layermixer')
        );

        var sources = new core.Sources(app);
        return sources.init(app.conf.variables, app.conf.sources);
    }).then(function (sources) {
        return init({
            core: core,
            app: app,
            sources: sources
        });
    }).return();
};

/* jshint node:true, unused:true */
'use strict';

var url = require('url');

var _ = require('lodash'),
    Q = require('q'),
    log = require('log4js').getLogger('schoolnet'),
    moment = require('moment'),
    rest = require('@gradecam/restler-q');

// This shouldn't be necessary as it should be the default form log4js but it isn't.
log.setLevel('INFO');

var DEFAULTS = {
    limit: 500,
    offset: 0,
};

var MAX_RETRIES = 3;

function SchoolnetApi(config) {
    config = config || {};
    var creds = {
        client_id: config.clientId || config.client_id,
        client_secret: config.clientSecret || config.client_secret,
        grant_type: 'client_credentials',
        scope: config.scope && 'default_tenant_path:' + config.scope
    };
    var baseUrl = url.parse(config.baseUrl || config.url || config.baseURL);
    this.baseURL = baseUrl.resolve('/api/v1/');
    this.tokenUrl = baseUrl.resolve('/api/oauth/token');
    this.token = void(0);
    this.expires = 0;
    this.omissions = ['links', 'institutionType'];
    this.oauthCreds = _.omit(creds, _.isEmpty);
}

var AUG = 7;

// var BACKOFF = [3000, 1000, 500];
var BACKOFF = [5 * 60 * 1000, 60 * 1000, 3 * 1000];

function backoff(idx) {
    var timeout = BACKOFF[idx];
    var dfd = Q.defer();
    log.info('Retrying request after:', timeout);
    setTimeout(function() {
        dfd.resolve(timeout);
    }, timeout);
    return dfd.promise;
}

var RETRY_CODES = ['ETIMEDOUT', 'ECONNRESET'];


module.exports = rest.service(SchoolnetApi, {}, {
    _requestToken: function _requestToken(creds, attemptsRemaining) {
        log.info('Requesting access token...');
        var self = this;
        return rest.post(self.tokenUrl, {data: creds}).then(function(data) {
            if (_.isEmpty(data.access_token)) {
                var err = new Error('Failed to obtain token.');
                err.body = data;
                return Q.reject(err);
            }
            return Q({access_token: data.access_token, expires: data.expires_in});
        }, function(err) {
            if (attemptsRemaining) {
                attemptsRemaining--;
                return backoff(attemptsRemaining).then(function() {
                    return self._requestToken(creds, attemptsRemaining);
                });
            }
        });

    },
    accessToken: function(creds) {
        var self = this;
        var start = Date.now();
        if (self.expires <= start) {
            return self._requestToken(creds, 3).then(function(data) {
                self.token = data.access_token;
                self.expires = (start + data.expires * 1000) - 10000;
                log.info('token obtained in: %dms expires: %d', Date.now() - start, self.expires);
                return self.token;
            });
        } else {
            log.debug('Using existing token.');
            return Q(self.token);
        }
    },
    _get: function _get(uri, options, attemptsRemaining) {
        var self = this;
        return self.get(uri, options).fail(function(err) {
            var retryCode = _.contains(RETRY_CODES, err.code);
            log.error('Request failed with error:', err);
            if (!(retryCode && attemptsRemaining)) {
                return Q.reject(err);
            }
            attemptsRemaining--;
            return backoff(attemptsRemaining).then(function() {
                return self._get(uri, options, attemptsRemaining);
            });
        });
    },
    apiGet: function(path, options, recursive) {
        var self = this;
        options = _.extend({query: {}}, options || {});
        log.debug('apiGet:', {path: path, options: options, recursive: recursive});
        if (recursive === void(0)) {
            if (options.limit || options.offset >= 0) {
                log.debug('limit or offset provided');
                recursive = options.recursive;
                options.query.limit = options.limit || DEFAULTS.limit;
                options.query.offset = options.offset || DEFAULTS.offset;
                delete options.limit;
                delete options.offset;
                delete options.recursive;
            } else {
                log.debug('neither limit nor offset provided');
                recursive = true;
                options.query.limit = DEFAULTS.limit;
                options.query.offset = DEFAULTS.offset;
            }
        }
        return self.accessToken(self.oauthCreds).then(function(token) {
            var opts = _.extend({}, options, {accessToken: token});
            log.debug('requesting:', {path: path, opts: opts});
            return self._get(path, opts, MAX_RETRIES).then(function(data) {
                data = data.data || {};
                if (_.isArray(data)) {
                    data = _.map(data, function(obj) {
                        return self.trimObj(obj, self.omissions);
                    });
                } else {
                    data = self.trimObj(data, self.omissions);
                }
                return data;
            });
        }).then(function(data) {
            if (!recursive || !_.isArray(data) || data.length < options.query.limit) {
                return data;
            }
            var limit = options.query.limit;
            var offset = options.query.offset += limit;
            log.debug('requesting next page', {limit: limit, offset: offset, options: options});
            return Q.when(self.apiGet(path, options, recursive)).then(function(results) {
                _.each(results, function(result) {
                    data.push(result);
                });
                return data;
            });
        });
    },
    apiPut: function(path, payload, options) {
        var self = this;
        return self.accessToken(self.oauthCreds).then(function(token) {
            var opts = _.extend({}, options || {}, {accessToken: token});
            log.debug('putting:', {path: path, opts: opts});
            return self.putJson(path, payload, opts).then(function(data) {
                data = data.data || {};
                if (_.isArray(data)) {
                    data = _.map(data, function(obj) {
                        return self.trimObj(obj, self.omissions);
                    });
                } else {
                    data = self.trimObj(data, self.omissions);
                }
                return data;
            });
       });
    },
    trimObj: function(obj, omissions) {
        obj = _.omit(obj, omissions);
        return obj;
    },
    /**
     * Retrieve list of Assessments
     *
     * @param opts object the options to use when retrieving the list of assessments.
     *                       default options: {limit: 100, offset: 0}
     **/
    getAssessments: function(opts) {
        var self = this;
        return Q.when(opts).then(function(opts) {
            opts = opts || {};
            var options = {
                query: {
                    filter: "teststage=='scheduled inprogress completed';itemtype==MultipleChoice,itemtype==TrueFalse",
                },
            };
            if (opts.modifiedsince) {
                var date = moment(opts.modifiedsince).format('MM-DD-YYYY');
                options.query.filter = 'modifiedsince==' + date + ';' + options.query.filter;
            }
            options = _.extend(options, _.pick(opts, 'limit', 'offset'));
            return self.apiGet('assessments', options).then(function(alist) {
                return _.filter(alist, function(x) {
                    return x.instanceId;
                });
            });
        });
    },
    getAssessment: function(ament) {
        var self = this;
        return Q.when(ament).then(function(ament) {
            var opts = {
                query: {
                    expand: 'assessmentquestion,assessmentschedule',
                }
            };
            ament = ament.id || ament.instanceId || ament.masterId || ament;
            return self.apiGet('assessments/' + ament, opts);
        });
    },
    getDistricts: function() {
        return this.apiGet('districts');
    },
    getSchool: function(school, opts) {
        var self = this;
        return Q.all([school, opts]).then(function(args) {
            var school = args[0];
            var opts = args[1];
            var schoolId = school.id || school.institutionId || school;
            opts = opts || {};
            return self.apiGet('schools/' + schoolId, opts);
        });
    },
    getSchools: function(district, opts) {
        var self = this;
        return Q.all([district, opts]).then(function(args) {
            var district = args[0];
            var opts = args[1];
            var district_id = district.id || district.institutionId || district;
            return self.apiGet('districts/' + district_id + '/schools', opts);
        });
    },
    getSection: function(section) {
        var self = this;
        return Q.when(section).then(function(section) {
            var sectionId = section.id || section.sectionId || section;
            var opts = {query: {expand: 'assessmentassignment,course,schedule'}};
            return self.apiGet('sections/' + sectionId, opts);
        });
    },
    getSections: function(school, opts) {
        var self = this;
        return Q.all([school, opts]).then(function(args) {
            var school = args[0];
            var opts = args[1];
            var schoolId = school.id || school.institutionId || school;
            return self.apiGet('schools/' + schoolId + '/sections', opts);
        });
    },
    getStudents: function(section, opts) {
        var self = this;
        return Q.all([section, opts]).then(function(args) {
            var section = args[0];
            var opts = args[1];
            var sectionId = section.id || section.sectionId || section;
            opts = _.extend(opts || {}, {query: {expand: 'identifier'}});
            return self.apiGet('sections/' + sectionId + '/students', opts);
        });
    },
    putStudentAssessment: function(obj) {
        var self = this;
        return Q.when(obj).then(function(obj) {
            if(!obj || !obj.assessmentId) {
                log.error('putStudentAssessment: Invalid asssessment: ', obj);
                return {success: false};
            }

            var url = 'assessments/' + obj.assessmentId + '/studentAssessments';
            return self.apiPut(url, obj).then(function() {
                return _.extend({success: true}, obj);
            }, function(err, response) {
                var dfd = Q.defer();
                if (err && err.stack) {
                    log.error('putStudentAssessment:', response, err.stack);
                } else {
                    log.warn('putStudentAssessment:', err, response);
                }
                dfd.resolve(_.extend({success: false}, obj, err));
                return dfd.promise;
            });
        });
    },
    getStaff: function(obj, opts) {
        var self = this;
        return Q.all([obj, opts]).then(function(args) {
            var obj = args[0];
            var opts = args[1];
            var staffId = obj.staffId || obj.teacher || obj.id || obj;
            opts = _.extend(opts || {}, {query: {expand: 'identifier'}});
            return self.apiGet('staff/' + staffId, opts);
        });
    },
    getStaffSections: function(obj) {
        var self = this;
        return Q.when(obj).then(function(obj) {
            var staff_id = obj.staffId || obj.teacher || obj.id || obj;
            return self.apiGet('staff/' + staff_id + '/staffSectionAssignments');
        });
    },
    getTenants: function() {
        var self = this;
        return self.get('tenants').then(function(data) {
            return _.map(data.data, function(data) {
                return self.trimObj(data, self.omissions);
            });
        });
    },
    setLogLevel: function(level) {
        log.setLevel(level);
    },
});

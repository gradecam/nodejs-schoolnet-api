"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var url = require("url");
var moment = require("moment");
var _ = require("lodash");
var log4js = require("log4js");
var P = require("bluebird");
var log = log4js.getLogger("schoolnet");
var rest = require("@gradecam/restler-q"); // tslint:disable-line
// This shouldn't be necessary as it should be the default form log4js but it isn't.
log.setLevel("INFO");
var DEFAULTS = {
    limit: 500,
    offset: 0,
};
var MAX_RETRIES = 3;
var SchoolnetApi = (function () {
    function SchoolnetApi(config) {
        config = config || {};
        var creds = {
            client_id: config.clientId || config.client_id,
            client_secret: config.clientSecret || config.client_secret,
            grant_type: "client_credentials",
            scope: config.scope && "default_tenant_path:" + config.scope
        };
        var baseUrl = config.baseUrl || config.url || config.baseURL;
        this.baseURL = url.resolve(baseUrl, "/api/v1/");
        this.tokenUrl = url.resolve(baseUrl, "/api/oauth/token");
        this.token = void (0);
        this.expires = 0;
        this.omissions = ["links", "institutionType"];
        this.oauthCreds = _.omit(creds, _.isEmpty);
    }
    return SchoolnetApi;
}());
exports.SchoolnetApi = SchoolnetApi;
// let BACKOFF = [3000, 1000, 500];
var BACKOFF = [5 * 60 * 1000, 60 * 1000, 3 * 1000];
function backoff(idx) {
    var timeout = BACKOFF[idx];
    var dfd = P.defer();
    log.info("Retrying request after:", timeout);
    setTimeout(function () {
        dfd.resolve(timeout);
    }, timeout);
    return dfd.promise;
}
var RETRY_CODES = ["ETIMEDOUT", "ECONNRESET"];
rest.service(SchoolnetApi, {}, {
    _requestToken: function _requestToken(creds, attemptsRemaining) {
        log.info("Requesting access token...");
        var self = this;
        return rest.post(self.tokenUrl, { data: creds }).then(function (data) {
            if (_.isEmpty(data.access_token)) {
                var err = new Error("Failed to obtain token.");
                err.body = data;
                return P.reject(err);
            }
            return P.resolve({ access_token: data.access_token, expires: data.expires_in });
        }, function (err) {
            if (attemptsRemaining) {
                attemptsRemaining--;
                return backoff(attemptsRemaining).then(function () {
                    return self._requestToken(creds, attemptsRemaining);
                });
            }
        });
    },
    accessToken: function accessToken(creds) {
        var self = this;
        var start = Date.now();
        if (self.expires <= start) {
            return self._requestToken(creds, 3).then(function (data) {
                self.token = data.access_token;
                self.expires = (start + data.expires * 1000) - 10000;
                log.info("token obtained in: %dms expires: %d", Date.now() - start, self.expires);
                return self.token;
            });
        }
        else {
            log.debug("Using existing token.");
            return P.resolve(self.token);
        }
    },
    _get: function _get(uri, options, attemptsRemaining) {
        var self = this;
        return self.get(uri, options).fail(function (err) {
            var retryCode = _.includes(RETRY_CODES, err.code);
            log.error("Request failed with error:", err);
            if (!(retryCode && attemptsRemaining)) {
                return P.reject(err);
            }
            attemptsRemaining--;
            return backoff(attemptsRemaining).then(function () {
                return self._get(uri, options, attemptsRemaining);
            });
        });
    },
    apiGet: function apiGet(path, options, recursive) {
        var self = this;
        options = _.extend({ query: {} }, options || {});
        log.debug("apiGet:", { path: path, options: options, recursive: recursive });
        if (recursive === void (0)) {
            if (options.limit || options.offset >= 0) {
                log.debug("limit or offset provided");
                recursive = options.recursive;
                options.query.limit = options.limit || DEFAULTS.limit;
                options.query.offset = options.offset || DEFAULTS.offset;
                delete options.limit;
                delete options.offset;
                delete options.recursive;
            }
            else {
                log.debug("neither limit nor offset provided");
                recursive = true;
                options.query.limit = DEFAULTS.limit;
                options.query.offset = DEFAULTS.offset;
            }
        }
        return self.accessToken(self.oauthCreds).then(function (token) {
            var opts = _.extend({}, options, { accessToken: token });
            log.debug("requesting:", { path: path, opts: opts });
            return self._get(path, opts, MAX_RETRIES).then(function (data) {
                data = data.data || {};
                if (_.isArray(data)) {
                    data = data.map(function (obj) { return self.trimObj(obj, self.omissions); });
                }
                else {
                    data = self.trimObj(data, self.omissions);
                }
                return data;
            });
        }).then(function (data) {
            if (!recursive || !_.isArray(data) || data.length < options.query.limit) {
                return data;
            }
            var limit = options.query.limit;
            var offset = options.query.offset += limit;
            log.debug("requesting next page", { limit: limit, offset: offset, options: options });
            return P.resolve(self.apiGet(path, options, recursive)).then(function (results) {
                _.each(results, function (result) {
                    data.push(result);
                });
                return data;
            });
        });
    },
    apiPut: function apiPut(path, payload, options) {
        var self = this;
        return self.accessToken(self.oauthCreds).then(function (token) {
            var opts = _.extend({}, options || {}, { accessToken: token });
            log.debug("putting:", { path: path, opts: opts });
            return self.putJson(path, payload, opts).then(function (data) {
                data = data.data || {};
                if (_.isArray(data)) {
                    data = data.map(function (obj) { return self.trimObj(obj, self.omissions); });
                }
                else {
                    data = self.trimObj(data, self.omissions);
                }
                return data;
            });
        });
    },
    trimObj: function trimObj(obj, omissions) {
        obj = _.omit(obj, omissions);
        return obj;
    },
    /**
     * Retrieve list of Assessments
     *
     * @param opts object the options to use when retrieving the list of assessments.
     *                       default options: {limit: 100, offset: 0}
     */
    getAssessments: function getAssessments(optsAny) {
        if (optsAny === void 0) { optsAny = null; }
        var self = this;
        return P.resolve(optsAny).then(function (opts) {
            opts = opts || {};
            var options = {
                query: {
                    filter: "teststage==\"scheduled inprogress completed\";itemtype==MultipleChoice,itemtype==TrueFalse",
                },
            };
            if (opts.modifiedsince) {
                var date = moment(opts.modifiedsince).format("MM-DD-YYYY");
                options.query.filter = "modifiedsince==" + date + ";" + options.query.filter;
            }
            options = _.extend(options, _.pick(opts, "limit", "offset"));
            return self.apiGet("assessments", options).then(function (alist) {
                return (alist || []).filter(function (x) { return x.instanceId; });
            });
        });
    },
    getAssessment: function getAssessment(objOrId) {
        var self = this;
        return P.resolve(objOrId).then(function (assessmentOrId) {
            var opts = {
                query: {
                    expand: "assessmentquestion,assessmentschedule",
                }
            };
            var assessmentOrIdAny = assessmentOrId;
            var id = assessmentOrIdAny.id || assessmentOrIdAny.instanceId || assessmentOrIdAny;
            return self.apiGet("assessments/" + id, opts);
        });
    },
    getDistricts: function getDistricts() {
        return this.apiGet("districts");
    },
    getSchool: function getSchool(obj, optsAny) {
        if (optsAny === void 0) { optsAny = null; }
        var self = this;
        return P.all([obj, optsAny]).then(function (args) {
            var school = args[0];
            var opts = args[1];
            var schoolId = school.id || school.institutionId || school;
            opts = opts || {};
            return self.apiGet("schools/" + schoolId, opts);
        });
    },
    getSchools: function getSchools(districtAny, optsAny) {
        if (optsAny === void 0) { optsAny = null; }
        var self = this;
        return P.all([districtAny, optsAny]).then(function (args) {
            var district = args[0];
            var opts = args[1];
            var districtId = district.id || district.institutionId || district;
            return self.apiGet("districts/" + districtId + "/schools", opts);
        });
    },
    getSection: function getSection(obj) {
        var self = this;
        return P.resolve(obj).then(function (section) {
            var sectionId = section.id || section.sectionId || section;
            var opts = { query: { expand: "assessmentassignment,course,schedule" } };
            return self.apiGet("sections/" + sectionId, opts);
        });
    },
    getSections: function getSections(obj, optsAny) {
        if (optsAny === void 0) { optsAny = null; }
        var self = this;
        return P.all([obj, optsAny]).then(function (args) {
            var school = args[0];
            var opts = args[1];
            var schoolId = school.id || school.institutionId || school;
            return self.apiGet("schools/" + schoolId + "/sections", opts);
        });
    },
    getStudents: function getStudents(obj, optsAny) {
        if (optsAny === void 0) { optsAny = null; }
        var self = this;
        return P.all([obj, optsAny]).then(function (args) {
            var section = args[0];
            var opts = args[1];
            var sectionId = section.id || section.sectionId || section;
            opts = _.extend(opts || {}, { query: { expand: "identifier" } });
            return self.apiGet("sections/" + sectionId + "/students", opts);
        });
    },
    putStudentAssessment: function putStudentAssessment(studentAssessment) {
        var self = this;
        return P.resolve(studentAssessment).then(function (obj) {
            if (!obj || !obj.assessmentId) {
                log.error("putStudentAssessment: Invalid asssessment: ", obj);
                return { success: false };
            }
            var url = "assessments/" + obj.assessmentId + "/studentAssessments";
            return self.apiPut(url, obj)
                .then(function () { return _.extend({ success: true }, obj); }, function (err, response) {
                if (err && err.stack) {
                    log.error("putStudentAssessment:", response, err.stack);
                }
                log.warn("putStudentAssessment:", JSON.stringify({
                    body: studentAssessment,
                    error: err,
                    response: response,
                }));
                return _.extend({ success: false }, obj, err);
            });
        });
    },
    getStaff: function getStaff(obj, opts) {
        if (opts === void 0) { opts = null; }
        var self = this;
        return P.all([obj, opts]).spread(function (objAny, optsAny) {
            var staffId = objAny.staffId || objAny.teacher || objAny.id || objAny;
            opts = _.extend(optsAny || {}, { query: { expand: "identifier" } });
            return self.apiGet("staff/" + staffId, opts);
        });
    },
    getStaffSections: function getStaffSections(obj) {
        var self = this;
        return P.resolve(obj).then(function (objAny) {
            var staffId = objAny.staffId || objAny.teacher || objAny.id || objAny;
            return self.apiGet("staff/" + staffId + "/staffSectionAssignments");
        });
    },
    getTenants: function getTenants() {
        var self = this;
        return self.get("tenants").then(function (data) {
            return data.data.map(function (x) { return self.trimObj(x, self.omissions); });
        });
    },
    setLogLevel: function setLogLevel(level) {
        log.setLevel(level);
    },
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2Nob29sbmV0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL3NjaG9vbG5ldC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLHlCQUEyQjtBQUMzQiwrQkFBaUM7QUFDakMsMEJBQTRCO0FBQzVCLCtCQUFpQztBQUNqQyw0QkFBOEI7QUFFOUIsSUFBTSxHQUFHLEdBQUcsTUFBTSxDQUFDLFNBQVMsQ0FBQyxXQUFXLENBQUMsQ0FBQztBQUMxQyxJQUFNLElBQUksR0FBUSxPQUFPLENBQUMscUJBQXFCLENBQUMsQ0FBQyxDQUFDLHNCQUFzQjtBQUV4RSxvRkFBb0Y7QUFDcEYsR0FBRyxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQztBQUVyQixJQUFJLFFBQVEsR0FBRztJQUNYLEtBQUssRUFBRSxHQUFHO0lBQ1YsTUFBTSxFQUFFLENBQUM7Q0FDWixDQUFDO0FBRUYsSUFBSSxXQUFXLEdBQUcsQ0FBQyxDQUFDO0FBRXBCO0lBUUksc0JBQVksTUFBVztRQUNuQixNQUFNLEdBQUcsTUFBTSxJQUFJLEVBQUUsQ0FBQztRQUN0QixJQUFJLEtBQUssR0FBcUI7WUFDMUIsU0FBUyxFQUFFLE1BQU0sQ0FBQyxRQUFRLElBQUksTUFBTSxDQUFDLFNBQVM7WUFDOUMsYUFBYSxFQUFFLE1BQU0sQ0FBQyxZQUFZLElBQUksTUFBTSxDQUFDLGFBQWE7WUFDMUQsVUFBVSxFQUFFLG9CQUFvQjtZQUNoQyxLQUFLLEVBQUUsTUFBTSxDQUFDLEtBQUssSUFBSSxzQkFBc0IsR0FBRyxNQUFNLENBQUMsS0FBSztTQUMvRCxDQUFDO1FBQ0YsSUFBSSxPQUFPLEdBQUcsTUFBTSxDQUFDLE9BQU8sSUFBSSxNQUFNLENBQUMsR0FBRyxJQUFJLE1BQU0sQ0FBQyxPQUFPLENBQUM7UUFDN0QsSUFBSSxDQUFDLE9BQU8sR0FBRyxHQUFHLENBQUMsT0FBTyxDQUFDLE9BQU8sRUFBRSxVQUFVLENBQUMsQ0FBQztRQUNoRCxJQUFJLENBQUMsUUFBUSxHQUFH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
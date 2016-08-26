import * as url from "url";
import * as moment from "moment";
import * as _ from "lodash";
import * as log4js from "log4js";
import * as P from "bluebird";

const log = log4js.getLogger("schoolnet");
const rest: any = require("restler-q");

// This shouldn't be necessary as it should be the default form log4js but it isn't.
log.setLevel("INFO");

let DEFAULTS = {
    limit: 500,
    offset: 0,
};

let MAX_RETRIES = 3;

class SchoolnetApiBase {
    baseURL: string;
    tokenUrl: string;
    token: string;
    expires: number;
    omissions: string[];
    oauthCreds: OAuthCredentials;

    constructor(config: any) {
        config = config || {};
        let creds: OAuthCredentials = {
            client_id: config.clientId || config.client_id,
            client_secret: config.clientSecret || config.client_secret,
            grant_type: "client_credentials",
            scope: config.scope && "default_tenant_path:" + config.scope
        };
        let baseUrl = config.baseUrl || config.url || config.baseURL;
        this.baseURL = url.resolve(baseUrl, "/api/v1/");
        this.tokenUrl = url.resolve(baseUrl, "/api/oauth/token");
        this.token = void(0);
        this.expires = 0;
        this.omissions = ["links", "institutionType"];
        this.oauthCreds = _.omit(creds, _.isEmpty) as OAuthCredentials;
    }
}

interface OAuthCredentials {
    client_id: string;
    client_secret: string;
    grant_type: string;
    scope?: string;
}

let AUG = 7;

// let BACKOFF = [3000, 1000, 500];
let BACKOFF = [5 * 60 * 1000, 60 * 1000, 3 * 1000];

function backoff(idx) {
    let timeout = BACKOFF[idx];
    let dfd = P.defer();
    log.info("Retrying request after:", timeout);
    setTimeout(function() {
        dfd.resolve(timeout);
    }, timeout);
    return dfd.promise;
}

let RETRY_CODES = ["ETIMEDOUT", "ECONNRESET"];

export type AssessmentIdLike = {id: string} | {instanceId: string} | string;
export type InstitutionIdLike = {id: string} | {institutionId: string} | string;
export type SchoolIdLike = {id: string} | {institutionId: string} | string;
export type SectionIdLike = {id: string} | {sectionId: string} | string;
export type StaffIdLike = {id: string} | {staffId: string} | {teacher: string} | string;

export interface SchoolnetApi {
    constructor(config: any);
    getAssessments(opts: any): PromiseLike<any>;
    getAssessment(assessment: any): PromiseLike<any>;
    getAssessment(assessmentOrId: AssessmentIdLike): PromiseLike<any>;
    getDistrincts(): PromiseLike<any>;
    getSchool(school: SchoolIdLike, opts: any): PromiseLike<any>;
    getSchools(district: InstitutionIdLike, opts: any): PromiseLike<any>;
    getSection(section: SectionIdLike): PromiseLike<any>;
    getSections(school: InstitutionIdLike, opts): PromiseLike<any>;
    getStudents(section: SectionIdLike, opts: any): PromiseLike<any>;
    putStudentAssessment(obj: any): PromiseLike<any>;
    getStaff(obj: StaffIdLike, opts: any): PromiseLike<any>;
    getStaffSections(obj: StaffIdLike): PromiseLike<any>;
    getTenants(): PromiseLike<any>;
    setLogLevel(level: string): void;
}

export const SchoolnetApi: SchoolnetApi = rest.service(SchoolnetApiBase, {}, {
    _requestToken: function _requestToken(creds, attemptsRemaining) {
        log.info("Requesting access token...");
        let self = this;
        return rest.post(self.tokenUrl, {data: creds}).then(function(data) {
            if (_.isEmpty(data.access_token)) {
                let err: any = new Error("Failed to obtain token.");
                err.body = data;
                return P.reject(err);
            }
            return P.resolve({access_token: data.access_token, expires: data.expires_in});
        }, function(err) {
            if (attemptsRemaining) {
                attemptsRemaining--;
                return backoff(attemptsRemaining).then(function() {
                    return self._requestToken(creds, attemptsRemaining);
                });
            }
        });

    },
    accessToken: function accessToken(creds) {
        let self = this;
        let start = Date.now();
        if (self.expires <= start) {
            return self._requestToken(creds, 3).then(function(data) {
                self.token = data.access_token;
                self.expires = (start + data.expires * 1000) - 10000;
                log.info("token obtained in: %dms expires: %d", Date.now() - start, self.expires);
                return self.token;
            });
        } else {
            log.debug("Using existing token.");
            return P.resolve(self.token);
        }
    },
    _get: function _get(uri, options, attemptsRemaining) {
        let self = this;
        return self.get(uri, options).fail(function(err) {
            let retryCode = _.includes(RETRY_CODES, err.code);
            log.error("Request failed with error:", err);
            if (!(retryCode && attemptsRemaining)) {
                return P.reject(err);
            }
            attemptsRemaining--;
            return backoff(attemptsRemaining).then(function() {
                return self._get(uri, options, attemptsRemaining);
            });
        });
    },
    apiGet: function apiGet(path, options, recursive) {
        let self = this;
        options = _.extend({query: {}}, options || {});
        log.debug("apiGet:", {path: path, options: options, recursive: recursive});
        if (recursive === void(0)) {
            if (options.limit || options.offset >= 0) {
                log.debug("limit or offset provided");
                recursive = options.recursive;
                options.query.limit = options.limit || DEFAULTS.limit;
                options.query.offset = options.offset || DEFAULTS.offset;
                delete options.limit;
                delete options.offset;
                delete options.recursive;
            } else {
                log.debug("neither limit nor offset provided");
                recursive = true;
                options.query.limit = DEFAULTS.limit;
                options.query.offset = DEFAULTS.offset;
            }
        }
        return self.accessToken(self.oauthCreds).then(function(token) {
            let opts = _.extend({}, options, {accessToken: token});
            log.debug("requesting:", {path: path, opts: opts});
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
            let limit = options.query.limit;
            let offset = options.query.offset += limit;
            log.debug("requesting next page", {limit: limit, offset: offset, options: options});
            return P.resolve(self.apiGet(path, options, recursive)).then(function(results) {
                _.each(results, function(result) {
                    data.push(result);
                });
                return data;
            });
        });
    },
    apiPut: function apiPut(path, payload, options) {
        let self = this;
        return self.accessToken(self.oauthCreds).then(function(token) {
            let opts = _.extend({}, options || {}, {accessToken: token});
            log.debug("putting:", {path: path, opts: opts});
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
    trimObj: function trimObj(obj, omissions) {
        obj = _.omit(obj, omissions);
        return obj;
    },
    /**
     * Retrieve list of Assessments
     *
     * @param opts object the options to use when retrieving the list of assessments.
     *                       default options: {limit: 100, offset: 0}
     **/
    getAssessments: function getAssessments(opts: any): PromiseLike<any> {
        let self = this;
        return P.resolve(opts).then(function(opts) {
            opts = opts || {};
            let options = {
                query: {
                    filter: "teststage==\"scheduled inprogress completed\";itemtype==MultipleChoice,itemtype==TrueFalse",
                },
            };
            if (opts.modifiedsince) {
                let date = moment(opts.modifiedsince).format("MM-DD-YYYY");
                options.query.filter = "modifiedsince==" + date + ";" + options.query.filter;
            }
            options = _.extend(options, _.pick(opts, "limit", "offset"));
            return self.apiGet("assessments", options).then(function(alist) {
                return _.filter(alist, function(x: any) {
                    return x.instanceId;
                });
            });
        });
    },
    getAssessment: function getAssessment(assessmentOrId: AssessmentIdLike): PromiseLike<any> {
        let self = this;
        return P.resolve(assessmentOrId).then(function(assessmentOrId: AssessmentIdLike) {
            let opts = {
                query: {
                    expand: "assessmentquestion,assessmentschedule",
                }
            };
            let assessmentOrIdAny: any = assessmentOrId;
            let id: string = assessmentOrIdAny.id || assessmentOrIdAny.instanceId || assessmentOrIdAny;
            return self.apiGet("assessments/" + id, opts);
        });
    },
    getDistricts: function getDistrincts(): PromiseLike<any> {
        return this.apiGet("districts");
    },
    getSchool: function getSchool(school: SchoolIdLike, opts: any): PromiseLike<any> {
        let self = this;
        return P.all([school, opts]).then(function(args) {
            let school: any = args[0];
            let opts: any = args[1];
            let schoolId: string = school.id || school.institutionId || school;
            opts = opts || {};
            return self.apiGet("schools/" + schoolId, opts);
        });
    },
    getSchools: function getSchools(district: InstitutionIdLike, opts: any): PromiseLike<any> {
        let self = this;
        return P.all([district, opts]).then(function(args) {
            let district: any = args[0];
            let opts: any = args[1];
            let district_id: string = district.id || district.institutionId || district;
            return self.apiGet("districts/" + district_id + "/schools", opts);
        });
    },
    getSection: function getSection(section: SectionIdLike): PromiseLike<any> {
        let self = this;
        return P.resolve(section).then(function(section: any) {
            let sectionId = section.id || section.sectionId || section;
            let opts = {query: {expand: "assessmentassignment,course,schedule"}};
            return self.apiGet("sections/" + sectionId, opts);
        });
    },
    getSections: function getSections(school: InstitutionIdLike, opts): PromiseLike<any> {
        let self = this;
        return P.all([school, opts]).then(function(args) {
            let school: any = args[0];
            let opts: any = args[1];
            let schoolId: string = school.id || school.institutionId || school;
            return self.apiGet("schools/" + schoolId + "/sections", opts);
        });
    },

    getStudents: function getStudents(section: SectionIdLike, opts: any): PromiseLike<any> {
        let self = this;
        return P.all([section, opts]).then(function(args) {
            let section: any = args[0];
            let opts: any = args[1];
            let sectionId: string = section.id || section.sectionId || section;
            opts = _.extend(opts || {}, {query: {expand: "identifier"}});
            return self.apiGet("sections/" + sectionId + "/students", opts);
        });
    },
    putStudentAssessment: function putStudentAssessment(obj: any): PromiseLike<any> {
        let self = this;
        return P.resolve(obj).then(function(obj) {
            if (!obj || !obj.assessmentId) {
                log.error("putStudentAssessment: Invalid asssessment: ", obj);
                return {success: false};
            }

            let url = "assessments/" + obj.assessmentId + "/studentAssessments";
            return self.apiPut(url, obj).then(function() {
                return _.extend({success: true}, obj);
            }, function(err, response) {
                let dfd = P.defer();
                if (err && err.stack) {
                    log.error("putStudentAssessment:", response, err.stack);
                } else {
                    log.warn("putStudentAssessment:", err, response);
                }
                dfd.resolve(_.extend({success: false}, obj, err));
                return dfd.promise;
            });
        });
    },
    getStaff: function getStaff(obj: StaffIdLike, opts: any): PromiseLike<any> {
        let self = this;
        return P.all([obj, opts]).then(function(args) {
            let obj: any = args[0];
            let opts: any = args[1];
            let staffId: string = obj.staffId || obj.teacher || obj.id || obj;
            opts = _.extend(opts || {}, {query: {expand: "identifier"}});
            return self.apiGet("staff/" + staffId, opts);
        });
    },
    getStaffSections: function getStaffSections(obj: StaffIdLike): PromiseLike<any> {
        let self = this;
        return P.resolve(obj).then(function(obj: any) {
            let staffId: string = obj.staffId || obj.teacher || obj.id || obj;
            return self.apiGet("staff/" + staffId + "/staffSectionAssignments");
        });
    },
    getTenants: function getTenants(): PromiseLike<any> {
        let self = this;
        return self.get("tenants").then(function(data) {
            return _.map(data.data, function(data) {
                return self.trimObj(data, self.omissions);
            });
        });
    },
    setLogLevel: function setLogLevel(level: string) {
        log.setLevel(level);
    },
});

export declare class SchoolnetApi {
    baseURL: string;
    tokenUrl: string;
    token: string;
    expires: number;
    omissions: string[];
    oauthCreds: OAuthCredentials;
    constructor(config: any);
}
export interface OAuthCredentials {
    client_id: string;
    client_secret: string;
    grant_type: string;
    scope?: string;
}
export declare type AssessmentIdLike = {
    id: string;
} | {
    instanceId: string;
} | string;
export declare type InstitutionIdLike = {
    id: string;
} | {
    institutionId: string;
} | string;
export declare type SchoolIdLike = {
    id: string;
} | {
    institutionId: string;
} | string;
export declare type SectionIdLike = {
    id: string;
} | {
    sectionId: string;
} | string;
export declare type StaffIdLike = {
    id: string;
} | {
    staffId: string;
} | {
    teacher: string;
} | string;
export interface ISchoolnetApi {
    constructor(config: any): any;
    getAssessments(opts?: any): PromiseLike<any>;
    getAssessment(assessment: any): PromiseLike<any>;
    getAssessment(assessmentOrId: AssessmentIdLike): PromiseLike<any>;
    getDistricts(): PromiseLike<any>;
    getSchool(school: SchoolIdLike, opts?: any): PromiseLike<any>;
    getSchools(district: InstitutionIdLike, opts?: any): PromiseLike<any>;
    getSection(section: SectionIdLike): PromiseLike<any>;
    getSections(school: InstitutionIdLike, opts?: any): PromiseLike<any>;
    getStudents(section: SectionIdLike, opts?: any): PromiseLike<any>;
    putStudentAssessment(obj: any): PromiseLike<any>;
    getStaff(obj: StaffIdLike, opts?: any): PromiseLike<any>;
    getStaffSections(obj: StaffIdLike): PromiseLike<any>;
    getTenants(): PromiseLike<any>;
    setLogLevel(level: string): void;
}

Schoolnet Api
=============

Schoolnet is always sold district or state wide, never to individual schools. As such
credentials used for retrieval will have access to one or more districts worth of data.

Workflow Overview
-----------------

The first step to integrating with Schoolnet is to obtain OAuth credentials, a `client ID`
and `client Secret`, to access the Schoolnet servers. If the Schoolnet system is setup as a 
multi-tenant environment an appropriate `tenant scope` is required for Agent mode to work correctly.
Once these credentials are obtained a synchronization workflow proceeds according to the following
pseudocode.

    for each district in schoolnet.getDistricts():
        for each school in schoolnet.getSchools(district):
            for each section in schoolnet.getSections(school):
                # load section details
                section = schoolnet.getSectionDetails(section)
                students = schoolnet.students(section)
                teacher = schoolnet.teacher(section)


Integration Notes
-----------------

When retrieving an Assessment it is necessary to pass along expand=assessmentquestion in the query parameters.
Failing to do so will result in getting only the metadata about the assessment and not the items which should
be presented to a student.

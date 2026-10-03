# Task policy resource visibility

## Characterization

Ordinary project access does not grant access to another user's unbound Connection. Existing Connection list and quota GET enforce this, but Task policy authoring and resource projection previously checked only tenant/organization/project tags. Native round71 OLD twice:3 failures/5 controls. Developer PUT accepts the hidden candidate and adds a success audit; developer/viewer GET of an existing policy returns its live provider, usedPercent and reset while Connection list hides it and quotaGET404. No runtime execution or billing exploit is claimed.

## Minimal HTTP correction

Reuse existing connectionVisibility in one id=ANY batch query with the current project role. GET retains the role returned by projectScope and filters only the policy passed into readResources, returning the original stored policy and Tasks. PUT uses the freshly locked role from withProjectWrite, validates the policy, requires every candidate visible and calls original savePolicy on that same client. Original tenant/organization/project/revocation checks and audit fields remain intact. No N+1, migration, Gateway read or credential conversion. Trusted CLI/store/router/supervisor authority is unchanged.

Connection lifecycle changes are not additionally locked or serialized by this slice; the C05/C06 project-authority locking guarantee remains intact. Historical configuration is not rewritten to hide live resource facts.

## Verification

Unchanged native GREEN:8 passed/0 failed/0 skipped,2.17 seconds. Test SHA256 matches frozen OLD `0608604830d88dfe04752e1d20d3e7ed0115b70f3d0e4f03b57585c181b30f0d`. Hidden PUT400 leaves policy/domain/history unchanged with no success audit; legacy GET hides all four live facts, retains the own resource and original policy. Own-unbound, same-project bound, admin and foreign-scope controls pass. C05 commands18, C06 policy ordering8 and existing Task routes11 also pass:45 total, zero fail/skip, no other fixture clients. Related scoped hashes remain stable. Nonincremental compiler, scoped lint/format and independent final read-only review pass. All evidence stays ignored under task-resource-visibility-round71. Manual updated; submit independently and continue the characterized policy-preview role boundary.

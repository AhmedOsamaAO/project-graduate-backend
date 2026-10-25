# Issue tracker: GitHub

- Repository: `AhmedOsamaAO/project-graduate-backend`.
- Issues, PRDs, and planning maps live in GitHub Issues. Use `gh`.
- PRs as a request surface: no. External PRs do not enter request triage.
- Read ticket bodies, labels, and comments before acting.

## Wayfinding operations

- Create the map as an issue labelled `wayfinder:map`.
- Create decision tickets as native sub-issues of the map, labelled only `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- Create all tickets before wiring their dependencies.
- Use native GitHub issue dependencies for blocking. The API requires the blocker's database ID, not its issue number.
- The frontier consists of open child issues with no open blockers and no assignee, ordered by their position under the map.
- Claim a ticket by assigning the driving developer before working.
- Resolve by posting a resolution comment, closing the ticket, and adding a named link with a short gist to the map's Decisions so far.
- Refer to maps and tickets by linked titles, not bare issue numbers.
- If native sub-issues are unavailable, use a named child task list on the map and a parent link in each child.
- If native dependencies are unavailable, record named blocker links in each ticket and check their states when selecting the frontier.

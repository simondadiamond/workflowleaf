The work is built, reviewed and committed. Deliver it into this run's pull
request.

1. Push the current branch to its upstream: `git push`. Never force-push.
2. Write the pull request body with `gh pr edit --body-file <file>`. It needs
   these sections:
   - `## Summary`: the problem in a sentence or two, then what changed.
   - `## Tests`: what the tests cover and how to run them.
   - `## Done when`: copied from `.workflowleaf/plan.md`.

Leave the pull request as a draft and never merge it. Once this stage's checks
pass, WorkflowLeaf marks it ready for review when the profile permits that, so
reviewers see it before the run waits for them. Merging stays a person's call.

If this delivery follows a correction that listed review threads, answer each
thread on the pull request after pushing. Reply with what changed and the
commit that changed it, then resolve the thread. A thread you disagree with
gets a reply saying why, and stays open for a person to decide.

```bash
gh api graphql -f query='mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }' -f id=<thread id>
```

Find thread ids with:

```bash
gh api graphql -f query='query($o: String!, $r: String!, $n: Int!) { repository(owner: $o, name: $r) { pullRequest(number: $n) { reviewThreads(first: 100) { nodes { id isResolved path line comments(first: 1) { nodes { body } } } } } } }' -f o=<owner> -f r=<repo> -F n=<number>
```

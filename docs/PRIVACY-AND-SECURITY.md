# Privacy and secret handling

This repository is intended to be publicly readable. Treat Git history, branches, tags, commit metadata, issue and pull request discussions, Actions logs/artifacts, and release assets as public, even while the repository is private. A later deletion from the working tree does not remove earlier versions.

## Before each push and release

1. Use a pseudonym and the GitHub `ID+username@users.noreply.github.com` commit email for **both** author and committer. Turn on GitHub's **Keep my email addresses private** for web-created commits. Inspect `git log --all --format='%an <%ae> | %cn <%ce> | %s'` after rebases or cherry-picks. Existing old commits do not change when account settings change.
2. Run `npm run audit:privacy` and `npm run check`. The privacy check examines all locally reachable refs, commit identities/messages and text blobs. CI repeats it on push and PR. It fails closed on binary or very large blobs pending manual review. It is a guardrail, not a proof that data is non-sensitive.
3. Inspect the full diff and all newly reachable history for credentials, personal names/emails, user data, real paths, hostnames/IPs, VPN/Tailscale details, cookies, proxy credentials, and logs. Use `example.invalid`, loopback and synthetic user/path examples for fixtures. Never include live config, diagnostics copied from the NAS, screenshots with private network details, or credential-bearing URLs.
4. Check Actions logs and artifacts, PR/Issue conversations, release notes/assets, and every branch/tag before changing visibility. Do not upload real server diagnostics to CI artifacts. Keep CI output to categories and locations; do not print matched secret values.
5. If any real secret ever reaches a commit, revoke or rotate it promptly, rewrite **every** affected branch/tag, and check old GitHub objects, cached views and other clones. A force push by itself cannot guarantee removal from GitHub caches or downstream copies. Keep the repository private until containment is verified; request GitHub Support cleanup if necessary.

The privacy scanner deliberately permits the repository pseudonym and specific GitHub noreply identities. Update its allowlist only after reviewing the intended public identity. Do not add blanket suppressions to make a failing check pass. A reviewer must still judge whether words such as company names, location hints or infrastructure topology can identify the owner.

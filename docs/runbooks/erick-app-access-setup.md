# Erick: full access to change the Hawley app

This checklist gets Erick (erick@bowlus.com) from nothing to having his Claude Code agent make, test, and ship changes to Hawley.

**Jacob** does the steps marked **J**, and **Erick** does the steps marked **E**. Sign-in details are passed in person or entered by the person themselves. **Never put a password, token, or key in chat, a file, GitHub, or a message to an agent.**

---

## 1. Claude (already done)
- [x] **J** Erick is a member of the Bowlus Claude Team workspace.
- [x] **J** He was added to the **Hawley App** project, and the whole org can edit it: https://claude.ai/project/01a18946-e72e-7102-bec2-0a06a487c7c9
- [ ] **E** Sign in to claude.ai as **erick@bowlus.com**, not a personal account. Open **Projects → Shared with you** and check that Hawley App is listed.

## 2. Tools on Erick's computer (Windows)
- [ ] **E** Install the Claude desktop app from https://claude.ai/download and sign in as erick@bowlus.com. Claude Code is in the **Code** tab.
- [ ] **E** Install Git for Windows (https://git-scm.com/download/win), which includes Git Bash.
- [ ] **E** Install Node.js 20 LTS or newer (https://nodejs.org).
- [ ] **E** Install the GitHub CLI: `winget install GitHub.cli`
- [ ] **E** Install the DigitalOcean CLI: `winget install DigitalOcean.Doctl`

## 3. GitHub: shared Bowlus account
The repo is `ProdEngineerBowlus/bowlus-hawley`, and it is public. Erick uses the shared **ProdEngineerBowlus** account, which is the repo admin.
- [ ] **J** Give Erick the ProdEngineerBowlus sign-in **in person**. If the account uses two-factor codes, arrange how he will get them.
- [ ] **E** Run `gh auth login`, then choose GitHub.com → HTTPS → "Login with a web browser", and sign in as ProdEngineerBowlus.
- [ ] **E** Check it worked: `gh api user --jq .login` should print `ProdEngineerBowlus`.
- [ ] **E** Run `git config --global user.name "Erick"` and `git config --global user.email "erick@bowlus.com"`, so his commits show up as his.

## 4. Get the code
- [ ] **E** Clone the repo and install:
  ```bash
  git clone https://github.com/ProdEngineerBowlus/bowlus-hawley C:/dev/bowlus-hawley
  cd C:/dev/bowlus-hawley
  npm install
  npm test
  ```
  `npm test` should pass, with 93 or more tests. It uses an embedded Postgres (PGlite), so it doesn't need a database.
- [ ] **E** In the Claude desktop app, open the Code tab, choose **C:\dev\bowlus-hawley** as the folder, and start a session.
- [ ] **E** Open the onboarding guide in Claude Code: https://claude.ai/claude-code/onboard/xKTWCwUVisLz

## 5. DigitalOcean: deploys, logs, database
The app deploys from `main` to DigitalOcean App Platform (app `b56a733a-3704-4537-8e43-560675c9cdae`, database `3173c8b8-455b-423f-a86f-a90a322a18ef`).
- [ ] **J** Invite erick@bowlus.com to the DigitalOcean team: cloud.digitalocean.com → Settings → Team → Invite Members. Give him the **Member** role, or **Owner** if he needs to manage billing and the team.
- [ ] **E** Accept the invite. Then go to API → Generate New Token, give the token a name, and choose read + write. Run `doctl auth init` and paste the token **into the terminal only**.
- [ ] **E** Check it worked: `doctl apps get b56a733a-3704-4537-8e43-560675c9cdae`.
- [ ] **E** For read-only DB checks, use the `bowlus_readonly` user. The agent can get its connection details from `doctl databases connection` and `doctl databases user get … --show` at runtime. Never copy them into files or chat.

## 6. Hawley app: admin role
- [ ] **J** Make Erick a Hawley admin so he can use the Admin pages (Releases, Workflow, Handoffs). The CLI needs the sync/admin database URL in your shell (`HAWLEY_SYNC_DATABASE_URL`, read from doctl, not a file).
  - Check whether he's already an admin (the pilot roster may have set "Erick T"): `npm run pg:hawley-auth-user -- list`
  - If he isn't, run: `npm run pg:hawley-auth-user -- set-role erick@bowlus.com admin`
  - If he has never signed in, set a temporary password instead, typing it only in the shell:
    ```powershell
    $env:HAWLEY_AUTH_PASSWORD="<temporary password>"
    npm run pg:hawley-auth-user -- set-password erick@bowlus.com --active --role=admin
    Remove-Item Env:\HAWLEY_AUTH_PASSWORD
    ```
- [ ] **E** Sign in to the Hawley web app, open **Admin**, and change the temporary password if asked.

## 7. Asana
- [ ] **J** Make sure Erick is a member, with edit rights, of the portfolios **VINs - 2026**, **Fabrication - 2026**, **Frames - 2026**, **CNC - 2026**, and their projects.
- [ ] **E** Optional: in the Claude desktop app, connect the **Asana** connector (Settings → Connectors) so his agent can look things up in Asana.
- The app's own Asana key (`ASANA_PAT`) lives only in the DigitalOcean app settings. Erick doesn't need a copy to work on the code.

## 8. How changes ship (rules)
1. Work on a branch, then push it and open a PR: `gh pr create`.
2. **Every merge to `main` deploys to production straight away.** Jacob merges only after he says "Allowed, merge it". GitHub can't enforce this, because everyone uses the same account, so the agent has to follow it.
3. Only one person writes to production at a time, including releases, gate passes, and data fixes. Tell Jacob first.
4. Don't create test work that workers can see without a controlled test plan.
5. Never turn Airtable jobs back on, cancel accounts, reset someone else's checkout, or delete history. **Airtable is not approved for cancellation.**
6. After a merge, watch the deploy: `doctl apps list-deployments b56a733a-3704-4537-8e43-560675c9cdae`.

## Done when
- [ ] Erick's agent can run `npm test`, open a PR as ProdEngineerBowlus, read deploy logs with `doctl`, and run read-only DB queries.
- [ ] Erick can sign in to Hawley Admin.

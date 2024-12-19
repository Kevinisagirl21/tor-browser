- **NOTE:** All examples in this template reference the rebase from Firefox 129.0a1 to 130.0a1

<details>
  <summary>Explanation of Channels</summary>

  There are unfortunately some collisions between how we and Mozilla name our release channels which can make things confusing:
  - **Firefox**:
    - **Nightly**: \_START and \_END tags, version in the format `$(MAJOR).$(MINOR)a1`
      - **Example**: Firefox Nightly 130 was `130.0a1`
      - **Note**: Nightly is 2 major versions ahead of the current Release
    - **Beta**: tagged each Monday, Wednesday, and Friday until release, version in the format `$(MAJOR).$(MINOR)b$(PATCH)`
      - **Example**: the first Firefox Beta 130 was `130.0b1`
      - **Note**: Beta is 1 major version ahead of the current Release, should be irrelevant to us
    - **Release**: tagged monthly, version in the format `$(MAJOR.$(MINOR).$(PATCH)`
      - **Example** Firefox Release 130 was `130.0.1`
    - **ESR**: tagged monthly, version in the format `$(ESR_MAJOR).$(ESR_MINOR).$(ESR_PATCH)esr`
      - **Example**: Firefox ESR 128.1 is `128.1.0esr`
  - **Tor+Mullvad Browser**:
    - **Rapid**: tagged monthly, based on the latest Firefox Nightly
    - **Nightly**: not tagged, built nightly from our current Alpha branch's `HEAD`
    - **Alpha**: tagged monthly, based on the latest Firefox ESR
    - **Stable**: tagged monthly, based on oldest supported Firefox ESR

</details>

<details>
  <summary>Branching Overview</summary>

  Rebasing Tor Browser Rapid onto the current Firefox Nightly is a bit more confusing/involved than rebasing Tor Browser Alpha or Stable from one minor ESR to the next minor ESR. The general process basically involves rebasing the previous Firefox Nightly-based Tor Browser Rapid onto the latest Firefox Nightly, and then cherry-picking all of the commits from the previous Firefox ESR-based Tor Browser Alpha after that channel's last `buildN` tag.

  This diagram provides a high-level view of the overall code-flow for rebasing/cherry-picking commits from Tor Browser Alpha based on Firefox 128.1.0esr and Tor Browser Rapid based on Firefox 129.0a1 onto Firefox 130.0a1:

  ```mermaid
%%{init: { 'theme': 'default', 'gitGraph': {'mainBranchName': 'tor-browser-128.1.0esr-14.5-1'}} }%%
gitGraph:
    branch tor-browser-129.0a1-15.0-2
    branch tor-browser-130.0a1-15.0-1

    checkout tor-browser-128.1.0esr-14.5-1
    commit id: "FIREFOX_128_1_0esr_BUILD1"
    commit id: "base-browser-128.1.0esr-14.5-build1"
    commit id: "tor-browser-128.1.0esr-14.5-build1"
    commit id: "tor-browser-128.1.0esr-14.5-build2"
    commit id: "tor-browser-128.1.0esr-14.5"

    checkout tor-browser-129.0a1-15.0-2
    commit id: "FIREFOX_NIGHTLY_129_END"
    commit id: "tor-browser-129.0a1-15.0-2-build1"

    checkout tor-browser-130.0a1-15.0-1
    commit id: "FIREFOX_NIGHTLY_130_END"
    branch tor-browser-130.0a1-15.0-2

    checkout tor-browser-130.0a1-15.0-1
    cherry-pick id: "FIREFOX_NIGHTLY_129_END"
    cherry-pick id: "tor-browser-129.0a1-15.0-2-build1"
    commit id: "tor-browser-130.0a1-15.0-1-build1"
    cherry-pick id: "tor-browser-128.1.0esr-14.5-build2"
    cherry-pick id: "tor-browser-128.1.0esr-14.5"
    commit id: "tor-browser-130.0a1-15.0-1-build2"

    checkout tor-browser-130.0a1-15.0-2
    cherry-pick id: "FIREFOX_NIGHTLY_130_END"
    cherry-pick id: "tor-browser-130.0a1-15.0-1-build2"
    commit id: "tor-browser-130.0a1-15.0-2-build1"
  ```

  In this concrete example, the rebaser performs the following steps:
  - create new `tor-browser-130.0a1-15.0-1`, and `tor-browser-130.0a1-15.0-2`branches from the `FIREFOX_NIGHTLY_130_END` tag.
    - these will be the rebase review branches
  - onto `tor-browser-130.0a1-15.0-1`, cherry-pick the range `FIREFOX_NIGHTLY_129_END..tor-browser-129.0a1-15.0-2-build1` (i.e. the Firefox Nightly 129-based Tor Browser Rapid commits)
    - this updates the previous Tor Browser Rapid onto Firefox Nightly 130
  - rebase+autosquash `tor-browser-130.0a1-15.0-1`
  - cherry-pick the new alpha patches onto `tor-browser-130.0a1-15.0-1` (i.e. cherry-pick `tor-browser-128.1.0esr-14.5-1-build2..origin/tor-browser-128.1.0esr-14.5-1`)
  - onto `tor-browser-130.0a1-15.0-2`, rebase the `FIREFOX_NIGHTLY_130_END..tor-browser-130.0a1-15.0-2` commit range, moving the fixup! commits to be adjacent to their referenced commits (i.e. the same rebase command queue as one would get from `git rebase --autosquash`, but with the `fixup! commands replaced with `pick!` commands).
    - this re-organises the branch in a nicely-bisectable way, and will ensure the rebase+autosquash step for the next release *should* succeed with minimal effort

</details>

<details>
  <summary>Explanation of Variables</summary>

- `$(NIGHTLY_VERSION)`: the Mozilla defined nightly version, used in various places for building tor-browser tags, labels, etc
  - **Example**: `130.0a1`
- `$(NIGHTLY_TAG)`: the Mozilla defined hg (Mercurial) tag associated with `$(NIGHTLY_VERSION)`
  - **Example**: `FIREFOX_NIGHTLY_130_END`
- `$(NIGHTLY_TAG_PREV)`: the Mozilla defined hg (Mercurial) tag associated with the previous nightly version when rebasing (ie, the nightly version we are rebasing from)
  - **Example**: `FIREFOX_NIGHTLY_129_END`
- `$(BROWSER_VERSION)`: the browser version which will first be based on the next major ESR version this *Firefox* Nightly series is leading up to
  - **Example**: `15`
- `$(TOR_BROWSER_BRANCH)`: the full name of the current `tor-browser` branch based off of the Firefox Nightly channel
  - **Example**: `tor-browser-130.0a1-15.0-1`
- `$(TOR_BROWSER_BRANCH_PREV)`: the full name of the previous `tor-browser` branch based off of the Firefox Nightly channel
  - **Example**: `tor-browser-129.0a1-15.0-1`
</details>

### Update Branch Protection Rules

- [ ] In [Repository Settings](https://gitlab.torproject.org/tpo/applications/tor-browser/-/settings/repository):
  - [ ] Remove previous nightly `tor-browser` branch protection rules (this will prevent pushing new changes to the branches being rebased)
  - [ ] Create new `tor-browser` branch protection rule:
    - **Branch**: `tor-browser-$(NIGHTLY_VERSION)-$(BROWSER_VERSION)-*`
      - **Example**: `tor-browser-130.0a1-15.0-*`
    - **Allowed to merge**: `Maintainers`
    - **Allowed to push and merge**: `Maintainers`
    - **Allowed to force push**: `false`
    - If you copied and pasted from old rules, double check you didn't add spaces at the end, as GitLab will not trim them!

### **Create New Branches**

- [ ] Find the Firefox mercurial tag `$(NIGHTLY_TAG)`
  - Go to `https://hg.mozilla.org/mozilla-central/tags`
  - Find and inspect the commit tagged with `$(NIGHTLY_TAG)`
    - Tags are in yellow in the Mercurial web UI
  - Find the equivalent commit in `https://github.com/mozilla/gecko-dev/commits/master
    - **Notice**: GitHub sorts commits by time, you might want to use `git log gecko-dev/master` locally, instead
  - Sign/Tag the `gecko-dev` commit: `git tag -as $(NIGHTLY_TAG) $(GIT_HASH) -m "Hg tag $(NIGHTLY_TAG)"`
- [ ] Create two new rapid `tor-browser` branches from Firefox mercurial tag
  - Branch name in the form: `tor-browser-$(NIGHTLY_VERSION)-$(BROWSER_VERSION)-${BRANCH_NUM}`
  - **Example**: `tor-browser-130.0a1-15.0-1` and `tor-browser-130.0a1-15.0-2`
- [ ] Push new `tor-browser` branches and the `firefox` tag to `upstream`

### **Rebase previous `-2` rapid branch's `-build1` tag onto current `-1` rapid branch**

- **Note** The output of this step should be the previous rapid branch rebased and autosquash'd onto the latest Firefox Nighty tag
- [ ] Checkout a new local branch for the first part of the `-1` rebase
  - **Example**: `git checkout -b rapid-rebase-part1 origin/tor-browser-130.0a1-15.0-1`
- [ ] Firefox Nightly-based `tor-browser` rebase:
  - [ ] cherry-pick previous Tor Browser Rapid `-2` branch to new `-1` rebase branch
    - **Example**: `git cherry-pick FIREFOX_NIGHTLY_129_END..tor-browser-129.0a1-15.0-2-build1`
  - [ ] rebase + autosquash commits
    - **Example**: `git rebase --autosquash --interactive FIREFOX_NIGHTLY_130_END`
- [ ] Rebase Verification:
    - [ ] Clean diff of diffs between previous rapid branch and current rebase branch
    - **Example**:
      ```bash
      git diff FIREFOX_NIGHTLY_129_END tor-browser-129.0a1-15.0-2-build1 > 129.diff
      git diff FIREFOX_NIGHTLY_130_END HEAD > 130.diff
      diff 129.diff 130.diff
      ```
    - **Note**: Only differences should be due to resolving merge conflicts with upstream changes from Firefox Nightly
- [ ] Open MR
- [ ] Merge
- [ ] Sign/Tag `HEAD` of the merged `tor-browser` branch:
  - In **tor-browser.git**, checkout the `-1` rapid `tor-browser` branch
  - In **tor-browser-build.git**, run signing script:
    ```bash
    ./tools/browser/sign-tag.torbrowser rapid build1
    ```
  - [ ] Push tag to `upstream`

### **Port new alpha patches to `-1`**

- **Note**: The output of this step should the rapid branch from the previous step with the previous release-cycle's new alpha patches cherry-picked to the end
- [ ] Checkout a new local branch for the second part of the `-1` rebase
  - **Example**: `git checkout -b rapid-rebase-part2 origin/tor-browser-130.0a1-15.0-1`
- [ ] Cherry-pick the new `tor-browser` alpha commits (i.e. the new dangling commits which did not appear in the previous Tor Browser Alpha release):
  - **Example** `git cherry-pick tor-browser-128.1.0esr-14.5-1-build2..origin/tor-browser-128.1.0esr-14.5-1`
- [ ] Rebase Verification
  - [ ] Clean diff of diffs between the alpha patch set ranges
  - **Example**:
    ```bash
    git diff tor-browser-128.1.0esr-14.5-1-build2 origin/tor-browser-128.1.0esr-14.5-1 > 128.1.0esr.diff
    git diff origin/tor-browser-130.0a1-15.0-1 HEAD > 130.diff
    diff 128.1.0esr.diff 130.diff
    ```
  - [ ] Clean range-diff between the alpha patch set ranges
  - **Example**:
    ```bash
    git range-diff tor-browser-128.1.0esr-14.5-1-build2..origin/tor-browser-128.1.0esr-14.5-1 origin/tor-browser-130.0a1-15.0-1..HEAD
    ```
  - **Note**: Only differences should be due to resolving merge conflicts with upstream changes from Firefox Nightly
- [ ] Open MR
- [ ] Merge
- [ ] Sign/Tag `HEAD` of the merged `tor-browser` branch:
  - In **tor-browser.git**, checkout the `-1` rapid `tor-browser` branch
  - In **tor-browser-build.git**, run signing script:
    ```bash
    ./tools/browser/sign-tag.torbrowser rapid build2
    ```
  - [ ] Push tag to `upstream`

### **Rebase and reorder tor-browser `-1` branch to new `-2` branch**
- **Note**: The output of this step should be the rapid branch from the previous step re-ordered but *not* squashed
- [ ] Checkout a new local branch for the `-2` rebase
  - **Example**: `git checkout -b rapid-rebase-part3 origin/tor-browser-130.0a1-15.0-2`
- [ ] Reset to `-1` HEAD
  - **Example**: `git reset --hard tor-browser-130.0a1-15.0-1-build2`
- [ ] Rebase and *partially* autosquash commits (i.e. replace `fixup!` with `pick!` commands)
    - **Example**: `git rebase --autosquash --interactive FIREFOX_NIGHTLY_130_END`
    - **Note**: After this step, the diff between the merged `-1` and in-progress `-2` branch should be empty
- [ ] Rebase Verification
  - [ ] Clean diff of diffs between rapid branches
  - **Example**:
    ```bash
    git diff FIREFOX_NIGHTLY_130_END tor-browser-130.0a1-15.0-1-build2 > 130-1.diff
    git diff FIREFOX_NIGHTLY_130_END HEAD > 130-2.diff
    ```
  - [ ] Understandable range-diff (i.e. `fixup!` patches are distributed from end of branch next to their parent)
  - **Example**:
    ```bash
    git range-diff FIREFOX_NIGHTLY_130_END..tor-browser-130.0a1-15.0-1-build2 FIREFOX_NIGHTLY_130_END..HEAD
    ```
- [ ] Open MR
- [ ] Merge
- [ ] Sign/Tag `HEAD` of the merged `tor-browser` branch:
  - In **tor-browser.git**, checkout the `-2` rapid `tor-browser` branch
  - In **tor-browser-build.git**, run signing script:
    ```bash
    ./tools/browser/sign-tag.torbrowser rapid build1
    ```
  - [ ] Push tag to `upstream`

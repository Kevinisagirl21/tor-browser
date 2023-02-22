**NOTE:** All examples reference the rebase from 102.7.0esr to 102.8.0esr

<details>
  <summary>Explanation of Variables</summary>
- `$(ESR_VERSION)` : the Mozilla defined ESR version, used in various places for building tor-browser tags, labels, etc
  - example : `102.8.0`
- `$(ESR_TAG)` : the Mozilla defined hg (Mercurial) tag associated with `$(ESR_VERSION)`
  - example : `FIREFOX_102_8_0esr_RELEASE`
- `$(ESR_TAG_PREV)` : the Mozilla defined hg (Mercurial) tag associated with the previous ESR version when rebasing (ie, the ESR version we are rebasing from)
- `$(BROWSER_MAJOR)` : the browser major version
  - example : `12`
- `$(BROWSER_MINOR)` : the browser minor version
  - example : either `0` or `5`; Alpha's is always `(Stable + 5) % 10`
- `$(BASE_BROWSER_BRANCH)` : the full name of the current `base-browser` branch
  - example: `base-browser-102.8.0esr-12.5-1`
- `$(BASE_BROWSER_BRANCH_PREV)` : the full name of the previous `base-browser` branch
  - example: `base-browser-102.7.0esr-12.5-1`
- `$(TOR_BROWSER_BRANCH)` : the full name of the current `tor-browser` branch
  - example: `tor-browser-102.8.0esr-12.5-1`
- `$(TOR_BROWSER_BRANCH_PREV)` : the full name of the previous `tor-browser` branch
  - example: `tor-browser-102.7.0esr-12.5-1`
</details>

**NOTE:** It is assumed that we've already identified the new esr branch during the tor-browser stable rebase

### **Bookkeeping**

- [ ] Link this issue to the appropriate [Release Prep](https://gitlab.torproject.org/tpo/applications/tor-browser-build/-/issues/?sort=updated_desc&state=opened&label_name%5B%5D=Release%20Prep) issue.

### Update Branch Protection Rules

- [ ] In [Repository Settings](https://gitlab.torproject.org/tpo/applications/tor-browser/-/settings/repository):
  - [ ] Remove previous alpha `base-browser` and `tor-browser` branch protection rules (this will prevent pushing new changes to the branches being rebased)
  - [ ] Create new `base-browser` and `tor-browser` branch protection rule:
    - **Branch**: `*-$(ESR_VERSION)esr-$(BROWSER_MAJOR).$(BROWSER_MINOR)-1*`
      - example: `*-102.8.0esr-12.5-1*`
    - **Allowed to merge**: `Maintainers`
    - **Allowed to push and merge**: `Maintainers`
    - **Allowed to force push**: `false`

### **Create New Branches**

- [ ] Create new alpha `base-browser` branch from Firefox mercurial tag (found during the stable rebase)
  - branch name in the form: `base-browser-$(ESR_VERSION)esr-$(BROWSER_MAJOR).$(BROWSER_MINOR)-1`
  - example: `base-browser-102.8.0esr-12.5-1`
- [ ] Create new alpha `tor-browser` branch from Firefox mercurial tag
  - branch name in the form: `tor-browser-$(ESR_VERSION)esr-$(BROWSER_MAJOR).$(BROWSER_MINOR)-1`
  - example: `tor-browser-102.8.0esr-12.5-1`
- [ ] Push new `base-browser` branch to `origin`
- [ ] Push new `tor-browser` branch to `origin`

### **Rebase base-browser**

- [ ] Checkout a new local branch for the `base-browser` rebase
  - example: `git branch base-browser-rebase FIREFOX_102_8_0esr_BUILD1`
- [ ] Cherry-pick the previous `base-browser` commits up to `base-browser`'s `build1` tag onto new `base-browser` rebase branch
  - example: `git cherry-pick FIREFOX_102_7_0esr_BUILD1..base-browser-102.7.0esr-12.5-1-build1`
- [ ] Rebase and autosquash these cherry-picked commits
  - example: `git rebase --autosquash --interactive FIREFOX_102_8_0esr_BUILD1 HEAD`
  - [ ] **(Optional)** Patch reordering
    - Relocate new `base-browser` patches in the patch-set to enforce this rough thematic ordering:
      - **MOZILLA BACKPORTS** - official Firefox patches we have backported to our ESR branch: Android-specific security updates, critical bug fixes, worthwhile features, etc
      - **MOZILLA REVERTS** - revert commits of official Firefox patches
      - **UPLIFT CANDIDATES** - patches which stand on their own and should be uplifted to `mozilla-central`
      - **BUILD CONFIGURATION** - tools/scripts, gitlab templates, etc
      - **BROWSER CONFIGURATION** - branding, mozconfigs, preference overrides, etc
      - **SECURITY PATCHES** - security improvements, hardening, etc
      - **PRIVACY PATCHES** - fingerprinting, linkability, proxy bypass, etc
      - **FEATURES** - new functionality: updater, UX, letterboxing, security level, add-on integration, etc
- [ ] Cherry-pick remainder of patches after the `build1` tag
  - example: `git cherry-pick base-browser-102.7.0esr-12.5-1-build1 origin/base-browser-102.7.0esr-12.5-1`
- [ ] Compare patch sets to ensure nothing *weird* happened during conflict resolution:
  - [ ] diff of diffs:
    -  Do the diff between `current_patchset.diff` and `rebased_patchset.diff` with your preferred difftool and look at differences on lines that starts with + or -
    - `git diff $(ESR_TAG_PREV)..$(BASE_BROWSER_BRANCH_PREV) > current_patchset.diff`
    - `git diff $(ESR_TAG)..$(BASE_BROWSER_BRANCH) > rebased_patchset.diff`
    - diff `current_patchset.diff` and `rebased_patchset.diff`
      - If everything went correctly, the only lines which should differ should be the lines starting with `index abc123...def456`
  - [ ] rangediff: `git range-diff $(ESR_TAG_PREV)..$(BASE_BROWSER_BRANCH_PREV) $(ESR_TAG)..HEAD`
    - example: `git range-dif FIREFOX_102_7_0esr_BUILD1..origin/base-browser-102.7.0esr-12.5-1 FIREFOX_102_8_0esr_BUILD1..HEAD`
- [ ] Open MR for the `base-browser` rebase
- [ ] Merge
- [ ] Sign/Tag HEAD of the merged new `base-browser` branch:
  - Tag : `base-browser-$(ESR_VERSION)esr-$(BROWSER_MAJOR).$(BROWSER_MINOR)-1-build1`
  - Message : `Tagging build1 for $(ESR_VERSION)esr-based alpha`
- [ ] Push tag to `origin`

### **Rebase tor-browser**

- [ ] Checkout a new branch for the `tor-browser` rebase starting from the `base-browser` `build1` tag
  - example: `git branch tor-browser-rebase base-browser-102.8.0esr-12.5-1-build1`
- [ ] Cherry-pick the previous `tor-browser` commits from `base-browser`'s previous `build1` tag up to `tor-browser`'s newest `buildN` tag (not necessarily `build1` if we have multiple build tags)
  - example: `git cherry-pick base-browser-102.7.0esr-12.5-1-build1..tor-browser-102.7.0esr-12.5-1-build1`
- [ ] Rebase and autosquash these cherry-picked commits (from the last new `base-browser` commit to `HEAD`)
  - example: `git rebase --autosquash --interactive base-browser-102.8.0esr-12.5-1-build1 HEAD`
  - [ ] **(Optional)** Patch reordering
    - Relocate new `tor-browser` patches in the patch-set to enforce this rough thematic ordering:
      - **BUILD CONFIGURATION** - tools/scripts, gitlab templates, etc
      - **BROWSER CONFIGURATION** - branding, mozconfigs, preference overrides, etc
      - **UPDATER PATCHES** - updater tweaks, signing keys, etc
      - **SECURITY PATCHES** - non tor-dependent security improvements, hardening, etc
      - **PRIVACY PATCHES** - non tor-dependent fingerprinting, linkability, proxy bypass, etc
      - **FEAURES** - non tor-dependent features
      - **TOR INTEGRATION** - legacy tor-launcher/torbutton, tor modules, bootstrapping, etc
      - **TOR SECURITY PATCHES** - tor-specific security improvements
      - **TOR PRIVACY PATCHES** - tor-specific privacy improvements
      - **TOR FEATURES** - new tor-specific functionality: manual, onion-location, onion service client auth, etc
- [ ] Cherry-pick remainder of patches after the last `buildN` tag
  - example: `git cherry-pick base-browser-102.7.0esr-12.5-1-build1..origin/tor-browser-102.7.0esr-12.5-1`
- [ ] Rebase and autosquash again (from the last new `base-browser` commit to `HEAD`), this time replacing all `fixup` and `squash` commands with `pick`. The goal here is to have all of the `fixup` and `squash` commits beside the commit which they modify.
  - example: `git rebase --autosquash --interactive base-browser-102.8.0esr-12.5-1-build1 HEAD`
  - **NOTE**: Do not allow `fixup` or `squash` commands here!
- [ ] Compare patch sets to ensure nothing *weird* happened during conflict resolution:
  - [ ] diff of diffs:
    -  Do the diff between `current_patchset.diff` and `rebased_patchset.diff` with your preferred difftool and look at differences on lines that starts with + or -
    - `git diff $(ESR_TAG_PREV)..$(BROWSER_BRANCH_PREV) > current_patchset.diff`
    - `git diff $(ESR_TAG)..$(BROWSER_BRANCH) > rebased_patchset.diff`
    - diff `current_patchset.diff` and `rebased_patchset.diff`
      - If everything went correctly, the only lines which should differ should be the lines starting with `index abc123...def456` (unless the previous `base-browser` branch includes changes not included in the previous `tor-browser` branch)
  - [ ] rangediff: `git range-diff $(ESR_TAG_PREV)..$(TOR_BROWSER_BRANCH_PREV) $(ESR_TAG)..HEAD`
    - example: `git range-dif FIREFOX_102_7_0esr_BUILD1..origin/tor-browser-102.7.0esr-12.5-1 FIREFOX_102_8_0esr_BUILD1..HEAD`
- [ ] Open MR for the `tor-browser` rebase
- [ ] Merge
- [ ] Sign/Tag HEAD of the merged new `tor-browser` branch:
  - Tag : `tor-browser-$(ESR_VERSION)esr-$(BROWSER_MAJOR).$(BROWSER_MINOR)-1-build1`
  - Message : `Tagging build1 for $(ESR_VERSION)esr-based alpha`
- [ ] Push tag to `origin`


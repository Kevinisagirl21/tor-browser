**NOTE:** All examples reference the rebase from 102.7.0esr to 102.8.0esr

<details>
  <summary>Explanation of variables</summary>
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
  - example: `base-browser-102.8.0esr-12.0-1`
- `$(BASE_BROWSER_BRANCH_PREV)` : the full name of the previous `base-browser` branch
  - example: `base-browser-102.7.0esr-12.0-1`
- `$(TOR_BROWSER_BRANCH)` : the full name of the current `tor-browser` branch
  - example: `tor-browser-102.8.0esr-12.0-1`
- `$(TOR_BROWSER_BRANCH_PREV)` : the full name of the previous `tor-browser` branch
  - example: `tor-browser-102.7.0esr-12.0-1`
</details>

### **Bookkeeping**

- [ ] Link this issue to the appropriate [Release Prep](https://gitlab.torproject.org/tpo/applications/tor-browser-build/-/issues/?sort=updated_desc&state=opened&label_name%5B%5D=Release%20Prep) issue.

### **Identify the Firefox Tagged Commit and Create New Branches**

- [ ] Find the Firefox mercurial tag here : https://hg.mozilla.org/releases/mozilla-esr102/tags
   - example: `FIREFOX_102_8_0esr_BUILD1`
- [ ] Find the analogous `gecko-dev` commit : https://github.com/mozilla/gecko-dev
  - Search for unique string found in the mercurial commit in the `gecko-dev/esr102` branch
  - example: 3a3a96c9eedd02296d6652dd50314fccbc5c4845
- [ ] Sign and Tag `gecko-dev` commit
  - Sign/Tag `gecko-dev` commit :
    - Tag : `$(ESR_TAG)`
    - Message : `Hg tag $(ESR_TAG)`
- [ ] Create new stable `base-browser` branch from tag
  - branch name in the form: `base-browser-$(ESR_VERSION)esr-$(BROWSER_MAJOR).$(BROWSER_MINOR)-1`
  - example: `base-browser-102.8.0esr-12.0-1`
- [ ] Create new stable `tor-browser` branch from
  - branch name in the form: `tor-browser-$(ESR_VERSION)esr-$(BROWSER_MAJOR).$(BROWSER_MINOR)-1`
  - example: `tor-browser-102.8.0esr-12.0-1`
- [ ] Push new `base-browser` branch to `origin`
- [ ] Push new `tor-browser` branch to `origin`
- [ ] Push new `$(ESR_TAG)` to `origin`

### **Rebase base-browser**

- [ ] Checkout a new branch for the `base-browser` rebase
  - example: `git branch base-browser-rebase FIREFOX_102_8_0esr_BUILD1`
- [ ] Cherry-pick the previous `base-browser` commits up to `base-browser`'s `build1` tag onto new `base-browser` rebase branch
  - example: `git cherry-pick FIREFOX_102_7_0esr_BUILD1..base-browser-102.7.0esr-12.0-1-build1`
- [ ] Rebase and autosquash these cherry-picked commits
  - example: `git rebase --autosquash --interactive FIREFOX_102_8_0esr_BUILD1 HEAD`
- [ ] Cherry-pick remainder of patches after the `build1` tag
  - example: `git cherry-pick base-browser-102.7.0esr-12.0-1-build1 origin/base-browser-102.7.0esr-12.0-1`
- [ ] Compare patch sets to ensure nothing *weird* happened during conflict resolution:
  - [ ] diff of diffs:
    -  Do the diff between `current_patchset.diff` and `rebased_patchset.diff` with your preferred difftool and look at differences on lines that starts with + or -
    - `git diff $(ESR_TAG_PREV)..$(BASE_BROWSER_BRANCH_PREV) > current_patchset.diff`
    - `git diff $(ESR_TAG)..$(BASE_BROWSER_BRANCH) > rebased_patchset.diff`
    - diff `current_patchset.diff` and `rebased_patchset.diff`
      - If everything went correctly, the only lines which should differ should be the lines starting with `index abc123...def456`
  - [ ] rangediff: `git range-diff $(ESR_TAG_PREV)..$(BASE_BROWSER_BRANCH_PREV) $(ESR_TAG)..HEAD`
    - example: `git range-dif FIREFOX_102_7_0esr_BUILD1..origin/base-browser-102.7.0esr-12.0-1 FIREFOX_102_8_0esr_BUILD1..HEAD`
- [ ] Open MR for the `base-browser` rebase
- [ ] Merge
- [ ] Sign/Tag HEAD of the merged new `base-browser` branch:
  - Tag : `base-browser-$(ESR_VERSION)esr-$(BROWSER_MAJOR).$(BROWSER_MINOR)-1-build1`
  - Message : `Tagging build1 for $(ESR_VERSION)esr-based stable`
- [ ] Push tag to `origin`

### **Rebase tor-browser**

- [ ] Checkout a new branch for the `tor-browser` rebase starting from the `base-browser` `build1` tag
  - example: `git branch tor-browser-rebase base-browser-102.8.0esr-12.0-1-build1`
- [ ] Cherry-pick the previous `tor-browser` commits from `base-browser`'s previous `build1` tag up to `tor-browser`'s newest `buildN` tag (not necessarily `build1` if we have multiple build tags)
  - example: `git cherry-pick base-browser-102.7.0esr-12.0-1-build1..tor-browser-102.7.0esr-12.0-1-build1`
- [ ] Rebase and autosquash these cherry-picked commits (from the last new `base-browser` commit to `HEAD`)
  - example: `git rebase --autosquash --interactive base-browser-102.8.0esr-12.0-1-build1 HEAD`
- [ ] Cherry-pick remainder of patches after the last `buildN` tag
  - example: `git cherry-pick base-browser-102.7.0esr-12.0-1-build1..origin/tor-browser-102.7.0esr-12.0-1`
- [ ] Compare patch sets to ensure nothing *weird* happened during conflict resolution:
  - [ ] diff of diffs:
    -  Do the diff between `current_patchset.diff` and `rebased_patchset.diff` with your preferred difftool and look at differences on lines that starts with + or -
    - `git diff $(ESR_TAG_PREV)..$(BROWSER_BRANCH_PREV) > current_patchset.diff`
    - `git diff $(ESR_TAG)..$(BROWSER_BRANCH) > rebased_patchset.diff`
    - diff `current_patchset.diff` and `rebased_patchset.diff`
      - If everything went correctly, the only lines which should differ should be the lines starting with `index abc123...def456`
  - [ ] rangediff: `git range-diff $(ESR_TAG_PREV)..$(TOR_BROWSER_BRANCH_PREV) $(ESR_TAG)..HEAD`
    - example: `git range-dif FIREFOX_102_7_0esr_BUILD1..origin/tor-browser-102.7.0esr-12.0-1 FIREFOX_102_8_0esr_BUILD1..HEAD`
- [ ] Open MR for the `tor-browser` rebase
- [ ] Merge
- [ ] Sign/Tag HEAD of the merged new `tor-browser` branch:
  - Tag : `tor-browser-$(ESR_VERSION)esr-$(BROWSER_MAJOR).$(BROWSER_MINOR)-1-build1`
  - Message : `Tagging build1 for $(ESR_VERSION)esr-based stable`
- [ ] Push tag to `origin`


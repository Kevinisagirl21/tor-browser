<details>
  <summary>Explanation of Variables</summary>
- `$(ESR_VERSION)` : the Mozilla defined ESR version, used in various places for building tor-browser tags, labels, etc
  - example : `102.8.0`
- `$(RR_VERSION)` : the Mozilla defined Rapid-Release version; Tor Browser for Android is based off of the `$(ESR_VERSION)`, but Mozilla's Firefox for Android is based off of the `$(RR_VERSION)` so we need to keep track of security vulnerabilities to backport from the monthly Rapid-Release train and our frozen ESR train.
  - example: `110`
- `$(TOR_BROWSER_MAJOR)` : the Tor Browser major version
  - example : `12`
- `$(TOR_BROWSER_MINOR)` : the Tor Browser minor version
  - example : either `0` or `5`; Alpha's is always `(Stable + 5) % 10`
- `$(BUILD_N)` : a project's build revision within a its branch; many of the Firefox-related projects have a `$(BUILD_N)` suffix and may differ between projects even when they contribute to the same build.
  - example : `build1`
</details>

**NOTE:** It is assumed the `tor-browser` rebase has already happened and there exists a `build1` build tag for both `base-browser` and `tor-browser`

### **Bookkeeping**

- [ ] Link this issue to the appropriate [Release Prep](https://gitlab.torproject.org/tpo/applications/tor-browser-build/-/issues/?sort=updated_desc&state=opened&label_name%5B%5D=Release%20Prep) issues (stable and alpha).

### **Security Vulnerabilities Report** : https://www.mozilla.org/en-US/security/advisories/

- Potentially Affected Components:
  - `firefox`/`geckoview` : https://github.com/mozilla/gecko-dev
  - `application-services` : https://github.com/mozilla/application-services
  - `android-components` : https://github.com/mozilla-mobile/firefox-android
  - `fenix` : https://github.com/mozilla-mobile/firefox-android

**NOTE:** `android-components` and `fenix` used to have their own repos, but since November 2022 they have converged to a single `firefox-android` repo. Any backports will require manually porting patches over to our legacy repos.

- [ ] Go through any `Security Vulnerabilities fixed in Firefox $(RR_VERSION)` (or similar) and create a candidate list of CVEs which potentially need to be backported in this issue:
  - CVEs which are explicitly labeled as 'Android' only
  - CVEs which are fixed in Rapid Release but not in ESR
  - 'Memory safety bugs' fixed in Rapid Release but not in ESR
- [ ] Foreach issue:
  - Create link to the CVE on [mozilla.org](https://www.mozilla.org/en-US/security/advisories/)
    - example: https://www.mozilla.org/en-US/security/advisories/mfsa2023-05/#CVE-2023-25740
  - Create link to the associated Bugzilla issues (found in the CVE description)
  - Create a link to the relevant `gecko-dev`/other commit hashes which need to be backported OR a brief justification for why the fix does not need to be backported
    - To find the `gecko-dev` version of a `mozilla-central`, search for a unique string in the relevant `mozilla-central` commit message in the `gecko-dev/release` branch log.
    - **NOTE:** This process is unfortunately somewhat poorly defined/ad-hoc given the general variation in how Bugzilla issues are labeled and resolved. In general this is going to involve a bit of hunting to identify needed commits or determining whether or not the fix is relevant.


### **tor-browser** : https://gitlab.torproject.org/tpo/applications/tor-browser.git
- [ ] Backport any Android-specific security fixes from Firefox rapid-release
  - [ ] Sign/Tag commit:
    - Tag : `tor-browser-$(ESR_VERSION)-$(TOR_BROWSER_MAJOR).$(TOR_BROWSER_MINOR)-1-$(BUILD_N)`
    - Message: `Tagging $(BUILD_N) for $(ESR_VERSION)-based alpha)`
  - [ ] Push tag to `origin`
**OR**
- [ ] No backports

### **application-services** : *TODO: we will need to setup a gitlab copy of this repo that we can apply security backports to if there are ever any security issues here*
- [ ] Backport any Android-specific security fixes from Firefox rapid-release
  - [ ] Sign/Tag commit:
    - Tag : `application-services-$(ESR_VERSION)-$(TOR_BROWSER_MAJOR).$(TOR_BROWSER_MINOR)-1-$(BUILD_N)`
    - Message: `Tagging $(BUILD_N) for $(ESR_VERSION)-based alpha`
  - [ ] Push tag to `origin`
  **OR**
- [ ] No backports


### **android-components** : https://gitlab.torproject.org/tpo/applications/android-components.git
- [ ] Backport any Android-specific security fixes from Firefox rapid-release
  - **NOTE**: Since November 2022, this repo has been merged with `fenix` into a singular `firefox-android` repo: https://github.com/mozilla-mobile/firefox-android. Any backport will require a patch rewrite to apply to our legacy `android-components` project.
  - [ ] Sign/Tag commit:
    - Tag : `android-components-$(ESR_VERSION)-$(TOR_BROWSER_MAJOR).$(TOR_BROWSER_MINOR)-1-$(BUILD_N)`
    - Message: `Tagging $(BUILD_N) for $(ESR_VERSION)-based alpha)`
  - [ ] Push tag to `origin`
**OR**
- [ ] No backports


### **fenix** : https://gitlab.torproject.org/tpo/applications/fenix.git
- [ ] Backport any Android-specific security fixes from Firefox rapid-release
  - **NOTE**: Since February 2023, this repo has been merged with `android-components` into a singular `firefox-android` repo: https://github.com/mozilla-mobile/firefox-android. Any backport will require a patch rewrite to apply to our legacy `fenix` project.
  - [ ] Sign/Tag commit:
    - Tag : `tor-browser-$(ESR_VERSION)-$(TOR_BROWSER_MAJOR).$(TOR_BROWSER_MINOR)-1-$(BUILD_N)`
    - Message: `Tagging $(BUILD_N) for $(ESR_VERSION)-based alpha)`
  - [ ] Push tag to `origin`
**OR**
- [ ] No backports

### CVEs

<!-- Create CVE resolution here -->

/confidential

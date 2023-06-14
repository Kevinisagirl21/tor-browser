## Merge Info

<!-- Bookkeeping information for release management -->

- ### Related Issues
  - tor-browser#xxxxx
  - tor-browser-build#xxxxx
  - etc

- ### Backport Timeline
  - [ ] **Immediate** - patchsets for critical bug fixes or other major blocker (e.g. fixes for a 0-day exploit) OR patchsets with trivial changes which do not need testing (e.g. fixes for typos or fixes easily verified in a local developer build)
  - [ ] **Next Minor Stable Release** - patchset that needs to be verified in nightly before backport
  - [ ] **Eventually** - patchset that needs to be verified in alpha before backport
  - [ ] **No Backport** - patchset for the next major stable

- ### Upstream Merging
  - [ ] Merge to `base-browser` - typically for `!fixups` to patches in the `base-browser` branch, though sometimes new patches as well
    - **NOTE**: if your changeset includes patches to both `base-browser` and `tor-browser` please please make separate merge requests for each part

- ### Issue Tracking
  - [ ] Link resolved issues with appropriate [Release Prep issue](https://gitlab.torproject.org/groups/tpo/applications/-/issues/?sort=updated_desc&state=opened&label_name%5B%5D=Release%20Prep&first_page_size=20) for changelog generation

## Change Description

<!-- Whatever context the reviewer needs to effectively review the patchset -->
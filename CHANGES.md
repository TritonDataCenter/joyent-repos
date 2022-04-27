# joyent-repos Changelog

## not yet released

## 2.6.0

- TOOLS-2543 MNX Tooling updates

## 2.5.1

- TOOLS-2434 Fix `jr` breakage in v2.2.0.

## 2.5.0

- `TOOLS-2346 set branch protection for Joyent eng repos that were never in gerrit`
  This makes `jr gh check` automatically skip repositories that have
  `nobranchprotection` set, indicating that no branch protection is required.

## 2.4.0

- `MANTA-4799 add branch protections on "mantav1" branches of the relevant manta repos`
  This updates the `jr gh` `check` and `set-branch-protection` subcommands so
  that they also operate on the `mantav1` branch protection settings of the
  given repository or repositories, if that branch exists.

## 2.3.0

- `TOOLS-2372 need a tool to toggle branch protection rules for illumos-joyent`
  This adds `jr gh set-branch-protection -s <list of statuses> ...` to specify
  the status checks that must pass on a github repository before a PR can be
  merged.

  It also adds `jr gh set-branch-protection -U <list of users>` to relax most
  branch protection checks, and remove status checks, allowing only the
  specified users to push to `master`.

  Typically the `-U` option would be used before pushing a direct merge to
  `master`, followed another `jr gh set-branch-protection` command with `-s`
  options to reinstate the branch-protection rules. Few Joyent repositories need
  this, `illumos-joyent` being the only one so far.

- TOOLS-2360 'jr github-settings ...' improve error handling

## 2.2.1

- Fix `jr github-settings set-branch-protection` handling on a repo that
  has *no* current "master" branch protection.

## 2.2.0

- Add `jr github-settings set-branch-protection`.
- Add `jr github-settings check`.

## 2.1.1

- Move smartos and manta repos.json files to 'tools/jr-manifest.json' in
  smartos-live.git and manta.git instead of hosting here.

## 2.1.0

- Respect `$JR_REPO_PATH_SUFFIX` to allow users to set a common suffix for all
  local repositories, e.g.:

        $ export JR_REPO_PATH_SUFFIX='.git'
        $ jr clone -y binder
        cloned "binder" to "/space/binder.git" (2s)

## 2.0.0

- [BREAKING CHANGE] The `-c` short option from `jr pull` has been removed.
  The long opt `--concurrency NUM` remains. The `-c NUM` option on `jr oneach`
  has been changed to be used for `-c COND-CMD, --condition COND-CMD`.
- Add `-c COND-CMD, --condition COND-CMD` option to `jr oneach CMD` to select a
  subset of repo clones in which to run `CMD`

  So, for example one can run `-c 'test -f package.json'` to only run my CMD in
  those repos that have a package.json file:

        $ jr oneach -o table -c 'test -f package.json' 'json -f package.json name version -a'
        moray                            moray-server 2.3.0
        mahi                             mahi 2.0.2
        aperture-config                  aperture-config 1.0.0
        binder                           binder 1.3.1
        mountain-gorilla                 mountain-gorilla 2.0.1
        keyapi                           keyapi 1.1.0
        manatee                          manatee 2.1.0

  or our current top-level deps on lru-cache:

        $ jr oneach -o table \
            -c '[[ -f package.json && -n $(json -f package.json dependencies.lru-cache) ]]' \
            'json -f package.json dependencies.lru-cache'
        mahi                  4.1.3
        binder                4.1.3
        node-libmanta         2.3.1
        moray                 2.5.0
        sdc-amonadm           2.3.0
        node-mahi             4.1.3
        node-ufds             ^2.5.0
        node-smartdc          2.2.0
        sdc-firewaller-agent  4.1.3
        sdc-docker            2.5.0
        triton-cns            4.1.3
        manta-minnow          4.1.3
        sdc-nfs               2.5.0
        sdc-portolan          4.1.3
        sdc-portolan-moray    2.5.0
        piranha               ^2.5.2
        electric-moray        4.1.3
        sdc-fwapi             4.1.3
        sdc-sdc               4.1.3
        sdc-manta             4.1.3
        manta-muskie          4.1.3
        manta-wrasse          4.1.3

## 1.1.0

- Bash completion for "REPO" arguments, e.g. `jr clone sdc<TAB>`.

## 1.0.0

First release.

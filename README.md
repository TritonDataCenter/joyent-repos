# joyent-repos

This repository defines a "jr-manifest.json" spec for how the set of repos for a
Triton product can be defined, including metadata (labels). It also provides a
tool (`jr`) for working with these repo manifests -- for example to enable
easily cloning one, a few, or all repos and running commands in those clones.
(This effort was done as part of [RFD
70](https://github.com/TritonDataCenter/rfd/blob/master/rfd/0070/README.md).)

## Motivation

Joyent has a number of products, e.g. Manta, Triton Data Center ("Triton" for
short), and SmartOS. Each of those products is comprised of a (often large)
number of git repositories. The release process needs to know which repos
represent top-level build components, which repos should be branched; a new
employee likely wants to clone most/all repos for a given product;
[etc](https://github.com/TritonDataCenter/rfd/blob/master/rfd/0070/README.md#use-cases-for-metadata).
Having some mechanism for structured and maintained repo metadata can help these
and many automation use cases.

## Overview

There is a "jr-manifest.json" file (following the spec defined below) in
the "master" repo of each product:

| Joyent Product         | JR manifest |
| ---------------------- | ----------- |
| Triton                 | [triton.git tools/jr-manifest.json](https://github.com/TritonDataCenter/triton/blob/master/tools/jr-manifest.json) |
| Manta                  | [manta.git tools/jr-manifest.json](https://github.com/TritonDataCenter/manta/blob/master/tools/jr-manifest.json) |
| SmartOS                | [smartos-live.git tools/jr-manifest.json](https://github.com/TritonDataCenter/smartos-live/blob/master/tools/jr-manifest.json) |
| Triton (private repos) | [triton-dev.git ./jr-manifest.json](https://github.com/TritonDataCenter/triton-dev/blob/master/jr-manifest.json) |

Then automation can use those as required. The provided `jr` tool can work
with the `jr-manifest.json` files in local clones of these repos.

### Registered users

Having a *registered* set of tools/processes using `jr` and this spec can
help immensely in maintaining it. Please add to this list if that's you.

Registered users:

- the `jr` tool in this repo
- as of TRITON-539,
  [sdcnode](https://github.com/TritonDataCenter/sdcnode#build-configurations) documents
  how to determine sdcnode usage using `jr ...` commands
- as of TOOLS-2143, the [sdcrelease](https://mo.joyent.com/engdoc/tree/master/sdcrelease)
  process uses `jr` when running scripts in the [triton.git](https://github.com/TritonDataCenter/triton)
  `./tools/releng` directory.

## JR Manifest Spec

A repo manifest is a JSON file that enumerates a set of repos, some metadata
on those repos (currently just labels), fields that define the scope of repos
for this manifest, and a set of repos that do *not* belong (to aid in
maintaining the file). The file is typically called "jr-manifest.json".
Typically the "set" represents the repos relevant for a Joyent product.
Currently the manifest enumerates repo *names*, assuming they are all on
GitHub and under the github.com/TritonDataCenter organization.

See the [example jr-manifest.json file](./examples/sample-jr-manifest.json).

A repo manifest file has the following fields:

- `jrVersion`: Currently `1`. This may be used in the future for versioning
  the spec.

- `description`: A short description for the set of repos.

- `repositories`: This is the array of included repositories. E.g.:

    ```json
    "repositories": [
        {
            "name": "mahi"
        },
        {
            "name": "rfd",
            "labels": {
                "meta": true
            }
        }
    ]
    ```

- `excludedRepositories`: This is an array of candidate repos names (see
  `repoCandidateSearch`) that are explicitly *not* considered part of this set.
  These are listed so that repeated runs of `jr update-manifest` need not
  revisit all repos everytime.

- `repoCandidateSearch`: An object providing data used by `jr update-manifest
  ...` to help maintain the manifest. It includes the following fields:

  - `description`: A sentence describing what qualifies a repo to belong in
    this manifest. This sentence is included shown to the user of
    `jr update-manifest`.
  - `type`: The "type" value to the [GitHub v3 API to "List organization
    repositories"](https://developer.github.com/v3/repos/#list-organization-repositories),
    e.g. "public".
  - `includeArchived` (boolean): Set this to true to have `jr update-manifest`
    consider repos that have been archived on GitHub. Defaults to false.

- `blessedLabels`: An array of objects describing "blessed" labels. These are
  show in the `jr update-manifest` UI to assist the maintainer in selecting
  useful labels. E.g.:

    ```json
    "blessedLabels": [
        {
            "name": "meta",
            "type": "boolean",
            "description": "a repo that isn't code, but ..."
        },
        {
            "name": "tritonservice",
            "type": "string",
            "description": "the top-level repo for a ..."
        }
    ],
    ```

  See also [Blessed
  labels](https://github.com/TritonDataCenter/joyent-repos#blessed-labels) below for some
  suggested label usage across all repo manifests.

- `defaults`: An object with default metadata for every included repo. The
  only metadata, and hence only supported defaults are `labels`, e.g.:

    ```json
    "defaults": {
        "labels": {
            "triton": true,
            "public": true
        }
    },
    ```

### Blessed labels

- `public: true|false` is used to indicate if the repo is public/private.
  in active use.

- `meta: true` is typical for repos that aren't code for the product but
  related, e.g. rfd.git and eng.git.
- `triton: true` is for repos related to the Triton product
- `manta: true` is for repos repos to the Manta product

- `release: true` should be set on a repo from which a Joyent eng release
  component is built. This decides what the [Joyent engineering release
  process](https://mo.joyent.com/docs/engdoc/master/sdcrelease/index.html)
  includes.
- `mg: <Jenkins job name>` Originally called 'mg' because it referred to
  [mountain-gorilla](https://github.com/TritonDataCenter/mountain-gorilla) targets,
  this maps the top-level repo to a Jenkins Job name.
  WARNING: The "sdc-headnode" repo is relevant for *multiple* Jenkins jobs. We've
  chosen to use the "headnode-joyent" target here.
- `buildisprivate: true` should be set on repos with a release build component
  (currently that is those with an `mg` label) if their built component is
  *private* (i.e. is uploaded to the `/Joyent_Dev/stor/builds` area). Note that
  this may differ from whether the repo itself is public (according to the
  `public` label).
- `image: <image name>` is used to not the name of the core image created by
  this repo, e.g. `"image": "manta-authcache"` for the mahi repo.
- `tritonservice: <service name>` is used to note which repo is the
  primary repo for a Triton service, e.g. `"tritonservice": "imgapi"` for
  the sdc-imgapi repo.
- `mantaservice: <service name>` is used to note which repo is the
  primary repo for a Manta service, e.g. `"mantaservice": "webapi"` for
  the manta-muskie repo.

## `jr`

A tool to work with these jr-manifest.json files and the repos mentioned in them.

### Setup

1. Install it:

    ```shell
    git clone git@github.com:TritonDataCenter/joyent-repos.git
    cd joyent-repos
    make
    export PATH=`pwd`/bin:$PATH
    ```

2. Update to the latest triton.git and triton-dev.git.

3. Config it:

    ```shell
    $ export JR_MANIFESTS=`pwd`/triton/tools/jr-manifest.json,
    `pwd`/manta/tools/jr-manifest.json,`pwd`/smartos-live/tools/jr-manifest.json,
    `pwd`/triton-dev/jr-manifest.json
    ```

    where those paths are adjusted to where *you* have local clones of
    [triton.git](https://github.com/TritonDataCenter/triton),
    [manta.git](https://github.com/TritonDataCenter/manta),
    [smartos-live.git](https://github.com/TritonDataCenter/smartos-live),
    and [triton-dev.git](https://github.com/TritonDataCenter/triton-dev).

    If you want repositories to be checked out to directories with a given
    suffix (e.g. <repo_name>.git) then set:

    ```shell
    export JR_REPO_PATH_SUFFIX='.git'
    ```

4. Check it by listing repos:

    ```shell
    jr --version
    jr list
    ```

### How to use `jr` to update the sdc-scripts git submodule in all Triton repos

Say you have a ticket (TRITON-NNN) to update all the Triton repos that build
service images to the latest sdc-scripts. Here is one way to use `jr` to
help do that.

1. Make a working dir and clone all the repos there:

    ```shell
    mkdir triton-NNN
    cd triton-NNN
    jr clone -y -l triton,vm
    ```

2. Update the submodule in each clone:

    ```shell
    jr oneach 'git submodule update --init -- deps/sdc-scripts'
    jr oneach 'cd deps/sdc-scripts && git checkout master'
    ```

    Unfortunately triton-cmon and triton-cns do it differently: using an npm
    dep for sdc-scripts, rather than git submodule.

    ```shell
    (cd sdc-papi/deps/sdc-scripts/ && git log -1 --pretty=format:%H)
    vi triton-cns/package.json
    vi triton-cmon/package.json
    ```

3. Inspect the diff in each repo to ensure it is copacetic:

    ```shell
    jr oneach 'git diff'
    ```

4. Start a Gerrit CR for each (assuming you use [grr](https://github.com/TritonDataCenter/grr)):

    ```json
    jr oneach 'grr TRITON-NNN'      # gathers info, creates feature branch
    jr oneach 'git commit -am "update to latest sdc-scripts"'
    jr oneach -c1 'grr'             # creates a CR
    open 'https://cr.joyent.us/#/q/is:open+TRITON-NNN'
    ```

    The `-c1` is for a concurrency of just one when pushing things to cr.joyent.us,
    otherwise I've found it fails a lot.

5. Get reviews on all those, then update the commit message:

    ```shell
    jr oneach 'grr'
    ```

    and submit them (TODO: finish `grr -S` for submitting).

6. Then clean up:

    ```shell
    cd ..
    rm -rf triton-NNN
    ```

Here is an example run for TRITON-380:
<https://gist.github.com/trentm/2abe2335f9997c511b683e67bd622d42>.

## Maintenance of repo manifest files

The "joyent" org has a *lot* of repositories. Trying to keep track of which
newly added repositories are relevant for a given repo manifest is tedious.
The `jr update-manifest MANIFEST-PATH` command is intended to help with this.
To support this command a manifest must have a `repoCandidateSearch` object
(see the spec above).

Periodically one should run `jr update-manifest MANIFEST-PATH` and walk through
the interactive steps to add (and/or explicitly exclude) new candidate repos.
The command will fetch all repos from GitHub's API matching the
`repoCandidateSearch` params and then have you edit the list to those that
should be included in the manifest (along with optionally adding labels) and
those that should be excluded.

Here is an example run:

```shell
$ jr update-manifest ~/joy/triton/tools/jr-manifest.json
Gathering candidate repos from GitHub.

* * *
The following 2 repo(s) have been archived, or are otherwise no longer
candidate repos for "/Users/trentm/joy/triton/tools/jr-manifest.json":
    node-tracker
    sdc-zookeeper
Remove them from the manifest? [Y/n]
Updated "/Users/trentm/joy/triton/tools/jr-manifest.json".

* * *
There are 3 candidate new repo(s) to work through:
    zoneinit
    keyapi
    cloud-init

The manifest defines relevant repos as follows:
    public github.com/TritonDataCenter repos directly relevant to development of TritonDC

The process is:
1. edit the list of repos to include in this manifest
   (possibly including additional labels)
2. edit the list of repos to exclude as not relevant
3. any left over repos are deferred until the next
   `jr update-manifest ...`

Hit <Enter> to open your editor, <Ctrl+C> to abort.
Updated "/Users/trentm/joy/triton/tools/jr-manifest.json".

* * *
Next we will handle *exclusions*, by editing the remaining
list of repos down to those to be excluded from this manifest.
Hit <Enter> to open your editor, <Ctrl+C> to abort.

No new repos to exclude.
```

When a manifest knows about all candidate repos, then a run will look like this:

```shell
$ jr update-manifest ~/joy/triton/tools/jr-manifest.json
Gathering candidate repos from GitHub.
No newly archived repos to remove from the manifest.
No new repos to add to the manifest.
```

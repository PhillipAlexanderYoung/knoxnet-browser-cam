# GitHub Publishing And Releases

This repository is intended to be free open source software under the Apache
License 2.0. Replace `YOUR_GITHUB_USER_OR_ORG` in the commands below with the
GitHub user or organization that should own the repo.

## Create And Push With GitHub CLI

```bash
cd /home/operator1/Documents/knoxnet-browser-cam
git status
git branch -M main
gh auth status
gh repo create YOUR_GITHUB_USER_OR_ORG/knoxnet-browser-cam --public --source=. --remote=origin --description "Phone browser camera for Knoxnet VMS with a local WebRTC receiver and RTSP bridge"
git push -u origin main
```

If `origin` already exists, set it directly:

```bash
cd /home/operator1/Documents/knoxnet-browser-cam
git remote set-url origin git@github.com:YOUR_GITHUB_USER_OR_ORG/knoxnet-browser-cam.git
git push -u origin main
```

## Manual GitHub Web UI Fallback

1. Create a new public GitHub repository named `knoxnet-browser-cam`.
2. Do not initialize it with a README, license, or `.gitignore`; this repo
   already contains those files.
3. Push from the local repo:

```bash
cd /home/operator1/Documents/knoxnet-browser-cam
git branch -M main
git remote add origin git@github.com:YOUR_GITHUB_USER_OR_ORG/knoxnet-browser-cam.git
git push -u origin main
```

If `origin` already exists:

```bash
cd /home/operator1/Documents/knoxnet-browser-cam
git remote set-url origin git@github.com:YOUR_GITHUB_USER_OR_ORG/knoxnet-browser-cam.git
git push -u origin main
```

## Create A Release

Use a version tag:

```bash
cd /home/operator1/Documents/knoxnet-browser-cam
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
gh release create v0.1.0 --title "knoxnet-browser-cam v0.1.0" --notes "Initial open-source release of the phone web app, local receiver, and RTSP bridge."
```

If `gh` is not authenticated, create the release in the GitHub web UI from the
`v0.1.0` tag.

## Optional Source Archive

GitHub automatically provides source `.zip` and `.tar.gz` assets for every tag.
If you want a local zip artifact too:

```bash
cd /home/operator1/Documents/knoxnet-browser-cam
git archive --format=zip --output knoxnet-browser-cam-v0.1.0.zip v0.1.0
```

For most users, cloning the repo or downloading GitHub's generated release
archive is simpler than publishing this monorepo as an npm package.

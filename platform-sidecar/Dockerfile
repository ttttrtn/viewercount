# Docker deployment for platform-sidecar (TikTok + Nimo).
#
# WHY DOCKER INSTEAD OF RENDER'S NATIVE PYTHON ENVIRONMENT:
# `playwright install chromium` during the native build step downloads
# the browser to a cache directory, but on Render's native Python
# builder that cache is not guaranteed to be the same filesystem the
# app runs on at request time - the build and runtime steps are not the
# same persistent disk. That's why the app can `pip install` cleanly
# but then fail at runtime with:
#   BrowserType.launch: Executable doesn't exist at
#   /opt/render/.cache/ms-playwright/chromium_headless_shell-.../...
# Baking the browser into the image at build time removes that gap
# entirely - whatever's in the image IS what runs, always.
#
# This uses Microsoft's official Playwright Python image, which ships
# with a Chromium build that is version-matched to a specific Playwright
# pip package version. That pairing is exact and load-bearing: this
# image tag (v1.56.0) MUST match the `playwright==1.56.0` pin in
# platform-sidecar/requirements.txt. If you bump one, bump the other.
FROM mcr.microsoft.com/playwright/python:v1.56.0-noble

# Keep Playwright from trying to (re-)download browsers at pip-install
# time - the base image already has them, at the path Playwright's
# Python client expects by default. This is the fix for the original
# error: no PLAYWRIGHT_BROWSERS_PATH override, no separate install step
# that could land browsers somewhere the runtime container doesn't see.
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY platform-sidecar/requirements.txt ./platform-sidecar/requirements.txt
RUN pip install --no-cache-dir -r platform-sidecar/requirements.txt

COPY platform-sidecar/app.py ./platform-sidecar/app.py

# Render injects PORT at runtime; app.py already reads it via
# os.environ.get("PORT", "5005") and binds 0.0.0.0, so no code change
# was needed there - this EXPOSE is documentation for local `docker run`,
# not what controls the actual port Render routes to.
EXPOSE 5005

CMD ["python", "platform-sidecar/app.py"]

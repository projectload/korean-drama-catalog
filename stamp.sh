#!/bin/sh
# Updates the BUILD stamp in index.html so open apps reload to the new version.
sed -i "s/const BUILD='[0-9]*'/const BUILD='$(date +%s)'/" index.html

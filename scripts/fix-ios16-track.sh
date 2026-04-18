#!/bin/bash
# Re-encode an MP3 to be iOS 16 Safari-safe.
#
# iOS 16 Safari occasionally refuses to play or cache MP3 files that have
# certain ID3v2 tag content or Xing/Info VBR headers. This script strips
# all metadata and re-encodes to a bare-minimum CBR 128kbps mono MP3, which
# plays cleanly on both iOS 16 (9th gen iPad) and iOS 17/18 (iPad Pro).
#
# Usage:  ./scripts/fix-ios16-track.sh tracks/song-name.mp3
#         ./scripts/fix-ios16-track.sh tracks/*.mp3           # batch
#
# Originals are backed up to tracks/_original_ios16_broken/ (git-ignored).

set -e

if [ $# -lt 1 ]; then
  echo "Usage: $0 <mp3-path> [<mp3-path> ...]"
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not found. Install with: brew install ffmpeg"
  exit 1
fi

BACKUP_DIR="tracks/_original_ios16_broken"
mkdir -p "$BACKUP_DIR"

for input in "$@"; do
  if [ ! -f "$input" ]; then
    echo "Skip (not found): $input"
    continue
  fi

  name=$(basename "$input")
  backup="$BACKUP_DIR/$name"

  # Don't re-backup if we've already got one — the original is the truth.
  if [ ! -f "$backup" ]; then
    cp "$input" "$backup"
  fi

  echo "Re-encoding: $input"
  # -write_xing 0   strip the Xing/Info VBR header (iOS 16 can choke on it)
  # -id3v2_version 0  don't write any ID3v2 tag
  # -map_metadata -1  drop all source metadata
  # -fflags / -flags +bitexact  no encoder signature, deterministic output
  ffmpeg -y -i "$backup" \
    -c:a libmp3lame -b:a 128k -ac 1 -ar 44100 \
    -write_xing 0 -id3v2_version 0 -map_metadata -1 \
    -fflags +bitexact -flags +bitexact \
    "$input" 2>&1 | grep -E "(size=|error|Error)" | tail -1

  oldsize=$(stat -f%z "$backup")
  newsize=$(stat -f%z "$input")
  echo "  $oldsize → $newsize bytes"
done

echo ""
echo "Done. Originals backed up in $BACKUP_DIR (git-ignored)."
echo "Now commit + deploy + recache on the 9th gen to test."

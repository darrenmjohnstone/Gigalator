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
#
# If ffmpeg fails on any file, the original is restored from backup so we
# never end up with zero-byte files in tracks/. A summary is printed at
# the end listing any files that couldn't be re-encoded.

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

succeeded=0
failed=0
failures=()

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

  # Refuse to operate on a file that's already a backed-up zero-byte
  # corpse — there's no original audio to recover from.
  if [ ! -s "$backup" ]; then
    echo "SKIP (backup is zero bytes — no source audio): $input"
    failed=$((failed + 1))
    failures+=("$input (no source)")
    continue
  fi

  echo "Re-encoding: $input"

  # Use a temp file so the original is never touched until we know the
  # re-encode succeeded with non-zero output.
  tmp="$input.reencode.tmp"

  if ffmpeg -y -i "$backup" \
       -c:a libmp3lame -b:a 128k -ac 1 -ar 44100 \
       -write_xing 0 -id3v2_version 0 -map_metadata -1 \
       -fflags +bitexact -flags +bitexact \
       "$tmp" </dev/null > /dev/null 2>&1 \
     && [ -s "$tmp" ]; then
    mv "$tmp" "$input"
    oldsize=$(stat -f%z "$backup")
    newsize=$(stat -f%z "$input")
    echo "  ok: $oldsize → $newsize bytes"
    succeeded=$((succeeded + 1))
  else
    # ffmpeg failed OR produced zero-byte output — clean up and leave original alone
    rm -f "$tmp"
    echo "  FAILED — keeping original"
    failed=$((failed + 1))
    failures+=("$input")
  fi
done

echo ""
echo "================================================================"
echo "Summary: $succeeded succeeded, $failed failed"
if [ $failed -gt 0 ]; then
  echo ""
  echo "Files that could not be re-encoded (originals untouched):"
  for f in "${failures[@]}"; do
    echo "  - $f"
  done
fi
echo ""
echo "Originals backed up in $BACKUP_DIR (git-ignored)."
echo "================================================================"

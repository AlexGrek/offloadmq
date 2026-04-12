#!/usr/bin/env bash
printf '| Directory | CSV Count |\n|---|---|\n'
while IFS= read -r dir; do
  count=$(find "$dir" -maxdepth 1 -type f -name "*.csv" | wc -l)
  printf '| %s | %s |\n' "$dir" "$count"
done < <(find . -mindepth 1 -type d | sort)

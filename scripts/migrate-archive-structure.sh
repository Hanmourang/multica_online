#!/usr/bin/env bash
# migrate-archive-structure.sh — projects_mgmt 存量目录一次性迁移（git mv 保历史）
#
# 来源：2026-09-05-project-archive-design.md §8 Phase 0 + §11 交付清单；
#       映射表见 projects_mgmt/CONTRACT.md §5。
# 存量整理的执行引擎已换为 _shared/archive/tools/doc_classifier.py --wave（见 archive/08）。
# 本脚本仅作对照；禁止再整树搬 page-navigator（含 dist/node_modules）。
#
# 用法：
#   scripts/migrate-archive-structure.sh [ARCHIVE_REPO]            # dry-run（默认）
#   scripts/migrate-archive-structure.sh --apply [ARCHIVE_REPO]    # 实跑 git mv
#
# 幂等：源不存在即跳过（可重复执行）；目标已存在时按文件级合入（git mv 逐文件）。
set -euo pipefail

APPLY=0
ARCHIVE_REPO=""
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    *) ARCHIVE_REPO="$arg" ;;
  esac
done
ARCHIVE_REPO="${ARCHIVE_REPO:-/Users/eleme/Documents/workspace/projects_mgmt}"

if [[ ! -d "$ARCHIVE_REPO/.git" ]]; then
  echo "ERROR: $ARCHIVE_REPO 不是 git 仓库" >&2
  exit 1
fi

moved=0
skipped=0

# git_mv_dir SRC DST：把 SRC 下所有内容（含子目录）git mv 到 DST。
git_mv_dir() {
  local src="$ARCHIVE_REPO/$1" dst="$ARCHIVE_REPO/$2"
  if [[ ! -d "$src" ]]; then
    echo "skip  $1/（不存在）"
    skipped=$((skipped+1))
    return
  fi
  if [[ "$APPLY" == "1" ]]; then
    mkdir -p "$dst"
    # 逐文件/逐子目录 git mv，目标已存在同名文件时保留两者交由人工合并。
    (cd "$src" && find . -type f -not -path '*/.git/*' | while read -r f; do
      rel="${f#./}"
      mkdir -p "$dst/$(dirname "$rel")"
      git -C "$ARCHIVE_REPO" mv -k "$1/$rel" "$2/$rel" 2>/dev/null || \
        echo "keep  $1/$rel（目标已存在，保留人工合并）"
    done)
  else
    local n
    n=$(find "$src" -type f -not -path '*/.git/*' | wc -l | tr -d ' ')
    echo "move  $1/  →  $2/  ($n 个文件)"
  fi
  moved=$((moved+1))
}

git_mv_file() {
  local src="$ARCHIVE_REPO/$1" dst="$ARCHIVE_REPO/$2"
  if [[ ! -f "$src" ]]; then
    echo "skip  $1（不存在）"
    skipped=$((skipped+1))
    return
  fi
  if [[ "$APPLY" == "1" ]]; then
    mkdir -p "$(dirname "$dst")"
    git -C "$ARCHIVE_REPO" mv -k "$1" "$2"
  else
    echo "move  $1  →  $2"
  fi
  moved=$((moved+1))
}

echo "== projects_mgmt 存量迁移（$([[ $APPLY == 1 ]] && echo APPLY || echo DRY-RUN)）=="
echo "仓库：$ARCHIVE_REPO"
echo

# CONTRACT.md §5 映射表逐行落地：
git_mv_dir  "0.调研"                                  "_shared/research"
git_mv_dir  "0.产品设计/dsh_desktop"                  "projects/dsh_desktop/overview/product-design"
git_mv_dir  "0.产品设计/project-archive"              "projects/multica/overview/product-design/project-archive"
git_mv_dir  "4.技术方案/dsh_desktop"                  "projects/dsh_desktop/overview/architecture"
git_mv_dir  "2.spec_infos/multica"                    "projects/multica/overview/architecture"
git_mv_dir  "2.spec_infos/dsh_desktop"                "projects/dsh_desktop/overview/architecture/spec_infos"
git_mv_dir  "2.spec_infos/eleme-agent"                "projects/eleme-agent/overview/architecture"
git_mv_dir  "2.spec_infos/eleme/alsc_ontology"        "projects/alsc-ontology/overview/architecture"
git_mv_file "1.requirements/SOP.md"                   "_shared/process/legacy-SOP.md"
git_mv_dir  "1.requirements/templates"                "_shared/format/templates"
git_mv_dir  "1.requirements/tools"                    "_shared/archive/tools"
git_mv_dir  "1.requirements/projects_mgmt"            "projects/projects_mgmt/requirements/REQ-20260902-01/s3-execution"
git_mv_dir  "3.phone_agent/产品风格"                   "_shared/design-system"
git_mv_dir  "3.phone_agent/accio_mobile"              "projects/accio_mobile/overview/product-design"
git_mv_dir  "3.phone_agent/AI阅读"                    "projects/ai_reading/overview/product-design"
git_mv_file "3.phone_agent/page-navigator/README.md"  "projects/ai_reading/overview/architecture/page-navigator-README.md"
git_mv_file "3.phone_agent/page-navigator/index.html" "projects/ai_reading/overview/architecture/page-navigator-index.html"

# *.zip 与重复 stitch HTML 副本 → _attic（本地留存，不进版本库索引）。
if [[ "$APPLY" == "1" ]]; then
  mkdir -p "$ARCHIVE_REPO/_attic"
  (cd "$ARCHIVE_REPO" && find . -maxdepth 2 -name '*.zip' -not -path './_attic/*' | while read -r f; do
    git mv -k "$f" "_attic/$(basename "$f")" 2>/dev/null || mv "$f" "_attic/$(basename "$f")"
  done)
  grep -q '^_attic/' "$ARCHIVE_REPO/.gitignore" 2>/dev/null || echo '_attic/' >> "$ARCHIVE_REPO/.gitignore"
fi

echo
echo "== 完成：$moved 组迁移，$skipped 组跳过 =="
if [[ "$APPLY" != "1" ]]; then
  echo "（dry-run：加 --apply 实跑）"
else
  echo "下一步：cd $ARCHIVE_REPO && git commit -m 'chore: 按 CONTRACT.md §5 迁移存量目录结构'"
fi

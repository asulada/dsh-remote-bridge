#!/usr/bin/env bash
# 一条命令发版（本仓 fork 版）：抬版本号 → 把 CHANGELOG 顶部的「未发布」抬成这一版 →
# 跑文档门禁 → 提交 → 打 tag → 推。推上去之后 GitHub Actions 自己干活：分支那趟跑
# `pnpm check`，tag 那趟（ubuntu + node 24 一格）打包 tgz 并建 GitHub Release。
#
# ## 为什么不复用 scripts/release.sh / pack-release.sh
#
# 那两份是**上游**的两阶段发版：本机打产物 + 发 Gitee 主站 + AtomGit 备站 + `npm publish`
# （`push-all.sh` / `sync-gitee-release.sh` / `release.sh` 里的坐标全是 `westanke/*`）。
# 本仓是 fork：没有那两个远端，也没有那个 npm 包的发布权。打包交给 GitHub Actions，
# 这里只负责把版本口径改对、tag 打对。
#
# ## 版本号要改 7 处（少一处 `pnpm docs:check` 就红）
#
#   package.json 的 `version`                       ← 门禁的真值
#   src/shared/version.ts 的 `PLUGIN_VERSION`
#   docs/api/openapi.yaml 的 `info.version`
#   docs/api/asyncapi.yaml 的 `info.version`
#   README.md 的「项目信息」小节（`vX.Y.Z` + 页眉 badge）
#   README.en.md 的「Project」小节（同上）
#   docs/project/CHANGELOG-DEV.md 的条目标题 `## vX.Y.Z · …`
#
# 前四处与 README 的中英两站由 scripts/check-project-docs.ts:310-370 严格核对；
# CHANGELOG 那条要求「有一条标题以该版本号开头」。所以脚本会把**最上面那条**
# `## 未发布 · …` 抬成 `## vX.Y.Z · …`（其余「未发布」条目留着，它们是下一版的内容）。
#
# ## 版本号怎么算
#
# 基准 = max(`package.json` 的 `X.Y.Z`, 最近一个 `v*` tag 的 `X.Y.Z`)；
# `vX.Y.Z` 还不存在 → 直接发 `X.Y.Z`（本仓仍是上游的 2.17.4、本地还没有 tag，
# 所以第一个 tag 是 `v2.17.4`）；已存在才按级别抬位：patch 2.17.4→2.17.5。
#
# ## 三道拒绝
#
#   - 工作区有 tracked 改动 → 拒绝（上面那 7 个文件除外；`ALLOW_DIRTY=1` 放行并打印清单）
#   - tag 已存在 → 拒绝（重发同一版：`git tag -d vX` + `git push origin :refs/tags/vX`）
#   - 当前分支不是 `main` → 拒绝（`BRANCH=<名字>` 覆盖）
#
# 用法：
#   bash scripts/bump-release.sh            # patch +1，提交 + 打 tag + 推（默认）
#   bash scripts/bump-release.sh minor      # 次版本 +1
#   bash scripts/bump-release.sh major      # 主版本 +1
#   bash scripts/bump-release.sh --dry-run  # 只算、只打印，不动任何文件、不推
set -euo pipefail
cd "$(dirname "$0")/.."

PKG="package.json"
VER_TS="src/shared/version.ts"
OPENAPI="docs/api/openapi.yaml"
ASYNCAPI="docs/api/asyncapi.yaml"
README_ZH="README.md"
README_EN="README.en.md"
CHANGELOG="docs/project/CHANGELOG-DEV.md"
BRANCH="${BRANCH:-main}"
LEVEL="patch"
DRY_RUN=0

say() { printf '\033[36m%s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }

for arg in "$@"; do
  case "$arg" in
    major|minor|patch) LEVEL="$arg" ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,52p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "不认识的参数：${arg}（只接 major|minor|patch、--dry-run）" ;;
  esac
done

for f in "$PKG" "$VER_TS" "$OPENAPI" "$ASYNCAPI" "$README_ZH" "$README_EN" "$CHANGELOG"; do
  [ -f "$f" ] || die "找不到 ${f}（请在仓根跑，或让脚本自己在仓根）"
done

# ── 1. 现状 ────────────────────────────────────────────────────────────
CUR_VER="$(grep -m1 '"version"' "$PKG" | sed -E 's/.*"version": *"([^"]+)".*/\1/')"
[ -n "$CUR_VER" ] || die "$PKG 里没有 version 字段"
case "$CUR_VER" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) die "$PKG 里的版本不是 X.Y.Z：$CUR_VER" ;;
esac

LAST_TAG="$(git tag --list 'v[0-9]*' --sort=-v:refname | head -n1 || true)"
LAST_VER="${LAST_TAG#v}"
[ -z "$LAST_TAG" ] && LAST_VER="0.0.0"

# 取两个 X.Y.Z 里大的那个。不用 `sort -V`：macOS 自带 sort 没 -V（BSD）。
max_ver() {
  awk -v a="$1" -v b="$2" 'BEGIN{
    split(a, A, "."); split(b, B, ".");
    for (i = 1; i <= 3; i++) {
      if (A[i] + 0 != B[i] + 0) { print (A[i] + 0 > B[i] + 0 ? a : b); exit }
    }
    print a
  }'
}

bump() { # $1=X.Y.Z $2=级别
  local M m p
  IFS=. read -r M m p <<<"$1"
  case "$2" in
    major) echo "$((M + 1)).0.0" ;;
    minor) echo "$M.$((m + 1)).0" ;;
    patch) echo "$M.$m.$((p + 1))" ;;
  esac
}

BASE="$(max_ver "$CUR_VER" "$LAST_VER")"
if git rev-parse -q --verify "refs/tags/v$BASE" >/dev/null; then
  NEW_VER="$(bump "$BASE" "$LEVEL")"
  REASON="v$BASE 已存在，$LEVEL +1"
else
  NEW_VER="$BASE"
  REASON="v$BASE 还没出现过，首个 tag 就用它"
fi
NEW_TAG="v$NEW_VER"

say "当前：package.json $CUR_VER ｜最近 tag：${LAST_TAG:-无}"
say "基准：${BASE}（${REASON}）"
say "目标：$NEW_VER ｜ tag $NEW_TAG ｜ 分支 $BRANCH"

# CHANGELOG 顶部那条「未发布」抬成这一版；先算出来给 dry-run 看。
ENTRY_LINE="$(grep -nE '^## 未发布 · ' "$CHANGELOG" | head -n1 || true)"
if [ -z "$ENTRY_LINE" ]; then
  if [ "$DRY_RUN" = 1 ]; then
    warn "$CHANGELOG 顶部没有「## 未发布 · …」条目 —— 这一版不会有变更记录，门禁会红。"
  else
    die "$CHANGELOG 顶部没有「## 未发布 · …」条目。
     门禁要求「有一条标题以新版本号开头」。先在 CHANGELOG 顶部写一条
     「## 未发布 · <一句话>」，再跑这个脚本 —— 它会把那条抬成 \`## $NEW_TAG · …\`。"
  fi
  NEW_ENTRY=""
else
  LINENO_OF_ENTRY="${ENTRY_LINE%%:*}"
  OLD_ENTRY="${ENTRY_LINE#*:}"
  NEW_ENTRY="## $NEW_TAG${OLD_ENTRY#\## 未发布}"
  say "CHANGELOG 第 $LINENO_OF_ENTRY 行："
  say "  旧：$OLD_ENTRY"
  say "  新：$NEW_ENTRY"
fi

if [ "$DRY_RUN" = 1 ]; then
  say "DRY_RUN=1：到此为止，没有改动任何文件、没有推送。"
  exit 0
fi

# ── 2. 安全闸 ──────────────────────────────────────────────────────────
DIRTY="$(git status --porcelain --untracked-files=no | grep -vE "^ M ($PKG|$VER_TS|$OPENAPI|$ASYNCAPI|$README_ZH|$README_EN|$CHANGELOG)$" || true)"
if [ -n "$DIRTY" ]; then
  if [ "${ALLOW_DIRTY:-0}" = "1" ]; then
    warn "工作区有未提交的 tracked 改动，ALLOW_DIRTY=1 放行（它们不会进这次提交）："
    printf '%s\n' "$DIRTY" >&2
  else
    printf '%s\n' "$DIRTY" >&2
    die "工作区不干净。先提交/暂存，或用 ALLOW_DIRTY=1 明确放行。"
  fi
fi

CUR_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$CUR_BRANCH" = "$BRANCH" ] || die "当前在 ${CUR_BRANCH}，不是 ${BRANCH}（用 BRANCH=$CUR_BRANCH 覆盖）"

if git rev-parse -q --verify "refs/tags/$NEW_TAG" >/dev/null; then
  die "tag $NEW_TAG 已存在。重发同一版请先 git tag -d $NEW_TAG && git push origin :refs/tags/$NEW_TAG"
fi

# ── 3. 写回版本号（保留原文件行尾：这些文件在本机是 CRLF，sed 会把 \r 吃掉）────
replace_line() { # $1=文件 $2=匹配用的 ERE $3=新行内容（不含行尾）
  local file="$1" pat="$2" new="$3" cr="" tmp
  if grep -q $'\r' "$file" 2>/dev/null; then cr=$'\r'; fi
  tmp="$(mktemp)"
  awk -v pat="$pat" -v new="$new" -v cr="$cr" \
    '$0 ~ pat { print new cr; next } { print }' "$file" >"$tmp"
  cat "$tmp" >"$file"   # 不用 mv：mv 换 inode，会丢权限位与硬链接
  rm -f "$tmp"
}

replace_sub() { # $1=文件 $2=字面量（正则元字符会被转义） $3=替换文本；行尾原样保留
  local file="$1" needle="$2" new="$3" tmp
  needle="$(printf '%s' "$needle" | sed 's/[][\\.^$*+?(){}|]/\\&/g')"
  tmp="$(mktemp)"
  # 走 ENVIRON 而不是 `awk -v`：-v 会把 `\.` 这层转义吃掉（还会报 warning），
  # ENVIRON 的字符串按字面进入 awk，正则里的 `\.` 才真的表示「字面点」。
  REPL_NEEDLE="$needle" REPL_NEW="$new" \
    awk 'BEGIN { n = ENVIRON["REPL_NEEDLE"]; w = ENVIRON["REPL_NEW"] } { gsub(n, w); print }' "$file" >"$tmp"
  cat "$tmp" >"$file"
  rm -f "$tmp"
}

replace_sub "$PKG" "\"version\": \"$CUR_VER\"" "\"version\": \"$NEW_VER\""
say "写入 ${PKG}：$NEW_VER"

replace_line "$VER_TS" '^export const PLUGIN_VERSION' "export const PLUGIN_VERSION = '$NEW_VER'"
say "写入 ${VER_TS}：PLUGIN_VERSION $NEW_VER"

# 两个 schema 的 info.version 都是文件里的第一处 `  version:`（缩进两格）。
replace_line "$OPENAPI" '^  version: ' "  version: $NEW_VER"
replace_line "$ASYNCAPI" '^  version: ' "  version: $NEW_VER"
say "写入 $OPENAPI / ${ASYNCAPI}：info.version $NEW_VER"

# README 两站各有两处：页眉 badge 与「项目信息 / Project」里的当前版本行。
replace_sub "$README_ZH" "v$CUR_VER" "v$NEW_VER"
replace_sub "$README_EN" "v$CUR_VER" "v$NEW_VER"
say "写入 $README_ZH / ${README_EN}：v$CUR_VER → v$NEW_VER"

if [ -n "$NEW_ENTRY" ]; then
  replace_line "$CHANGELOG" '^## 未发布 · ' "$NEW_ENTRY"
  say "写入 ${CHANGELOG}：顶部「未发布」→「${NEW_TAG}」"
fi

# 自查：三处硬判据（门禁会红的那三条，先自己看一眼）
grep -q "\"version\": \"$NEW_VER\"" "$PKG" || die "写回后 $PKG 不是 $NEW_VER"
grep -q "PLUGIN_VERSION = '$NEW_VER'" "$VER_TS" || die "写回后 $VER_TS 不是 $NEW_VER"
grep -qE "^## v?$NEW_VER([ ·-]|$)" "$CHANGELOG" || die "写回后 $CHANGELOG 里没有 $NEW_VER 的条目标题"

# ── 4. 文档门禁（本机能跑的那道；typecheck/test 交给 CI）─────────────────────
if [ -x node_modules/.bin/tsx ]; then
  say "跑文档门禁：node_modules/.bin/tsx scripts/check-project-docs.ts"
  node_modules/.bin/tsx scripts/check-project-docs.ts || die "文档门禁红了，已改的文件留在工作区，自己看一眼再重跑"
  say "文档门禁通过"
else
  warn "没找到 node_modules/.bin/tsx（没装依赖？），跳过文档门禁 —— CI 会兜住，但本地先绿更省事"
fi

# ── 5. 提交 + 打 tag + 推 ──────────────────────────────────────────────
git add "$PKG" "$VER_TS" "$OPENAPI" "$ASYNCAPI" "$README_ZH" "$README_EN" "$CHANGELOG"
git commit --quiet -m "chore(release): $NEW_TAG"
say "已提交：chore(release): $NEW_TAG"

git tag -a "$NEW_TAG" -m "$NEW_TAG" "$(git rev-parse HEAD)"
say "已打 tag：$NEW_TAG"

say "推分支 $BRANCH …"
git push origin "$BRANCH"
say "推 tag $NEW_TAG …（CI 会打包 tgz 并建 GitHub Release）"
git push origin "$NEW_TAG"

REMOTE_URL="$(git remote get-url origin 2>/dev/null || echo '')"
SLUG="$(printf '%s' "$REMOTE_URL" | sed -E 's#.*[:/]([^/:]+/[^/:]+?)(\.git)?$#\1#')"
say "推完了。看进度：https://github.com/${SLUG}/actions"
say "Release 会落在：https://github.com/${SLUG}/releases/tag/${NEW_TAG}"
say "两家分工：分支那趟跑 pnpm check，tag 那趟打包 + 发版（ci.yml 不认 tag，只有 release 那步认）。"

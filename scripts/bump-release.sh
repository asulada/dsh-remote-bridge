#!/usr/bin/env bash
# 一条命令发版（本仓 fork 版）：抬版本号 → 把 CHANGELOG 顶部的「未发布」抬成这一版 →
# 跑文档门禁 → 提交 → 打 tag → **只推 tag**（`PUSH_TAG=0` 连 tag 也不推，全留在本地）。
# 分支（main）由你自己推，脚本不碰：
# 顺序是「你先 push 分支 → 等 ci.yml 绿 → 再跑本脚本」，脚本只把发版这一步推出去。
# tag 推上去之后 GitHub Actions 干活：tag 那趟（ubuntu + node 24 一格）跑 `pnpm pack`
# （= prepack 的完整 `pnpm check`）打包 tgz 并建 GitHub Release。
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
#   README.md 的「项目信息」小节（`vX.Y.Z-asulada.N` + 页眉 badge）
#   README.en.md 的「Project」小节（同上）
#   docs/project/CHANGELOG-DEV.md 的条目标题 `## vX.Y.Z-asulada.N · …`
#
# 前四处与 README 的中英两站由 scripts/check-project-docs.ts 严格核对；
# CHANGELOG 那条要求「有一条标题以该版本号开头」。所以脚本会把**最上面那条**
# `## 未发布 · …` 抬成 `## vX.Y.Z-asulada.N · …`（其余「未发布」条目留着，
# 它们是下一版的内容）。
#
# ## 版本号怎么算（后缀区分，2026-11-28 用户定）
#
# 形如 `X.Y.Z-asulada.N`：核心号跟上游对齐，`-asulada.N` 是本仓在这个核心号上的第 N 次
# 发布。口径与理由见 docs/decisions/2026-11.md 的「版本号后缀区分」。
#
#   patch/minor/major   核心号抬位、N 归 1：2.17.5 → 2.17.6-asulada.1
#   rev                 核心号不动、N +1：2.17.6-asulada.1 → 2.17.6-asulada.2
#
# 后缀不改变任何运行时行为：客户端的能力判断走 `connection.ready` 的能力位，「最低版本」
# 只是安装门槛（AGENTS.md §1）；本仓也不发 npm 包（发布者是上游）。核心号一律取
# 「比已并入的上游版本高一格」，好让 `v2.17.6-asulada.1` 在 semver 排序上明确晚于上游 2.17.5。
#
# ## 三道拒绝
#
#   - 工作区有 tracked 改动 → 拒绝（上面那 7 个文件除外；`ALLOW_DIRTY=1` 放行并打印清单）
#   - tag 已存在 → 拒绝（重发同一版：`git tag -d vX` + `git push origin :refs/tags/vX`）
#   - 当前分支不是 `main` → 拒绝（`BRANCH=<名字>` 覆盖）
#
# 用法：
#   bash scripts/bump-release.sh            # patch：核心号 +1、N 归 1（默认；提交+tag+推 tag）
#   bash scripts/bump-release.sh rev        # 同一核心号再发一次：N +1
#   bash scripts/bump-release.sh minor      # 次版本 +1
#   bash scripts/bump-release.sh major      # 主版本 +1
#   bash scripts/bump-release.sh --dry-run  # 只算、只打印，不动任何文件、不推
#   PUSH_TAG=0 bash scripts/bump-release.sh # 提交与 tag 都留在本地，一个字节都不推
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
# 版本后缀的固定字（`X.Y.Z-asulada.N`）：换它就等于换一套版本号口径，别随手改。
STEM="asulada"
# 1 = 打 tag 后推 origin（默认）；0 = 连 tag 都不推，全留在本地（本机没网/没授权时用）。
PUSH_TAG="${PUSH_TAG:-1}"

say() { printf '\033[36m%s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }

for arg in "$@"; do
  case "$arg" in
    major|minor|patch|rev) LEVEL="$arg" ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,55p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "不认识的参数：${arg}（只接 major|minor|patch|rev、--dry-run）" ;;
  esac
done

for f in "$PKG" "$VER_TS" "$OPENAPI" "$ASYNCAPI" "$README_ZH" "$README_EN" "$CHANGELOG"; do
  [ -f "$f" ] || die "找不到 ${f}（请在仓根跑，或让脚本自己在仓根）"
done

# ── 1. 现状 ────────────────────────────────────────────────────────────
CUR_VER="$(grep -m1 '"version"' "$PKG" | sed -E 's/.*"version": *"([^"]+)".*/\1/')"
[ -n "$CUR_VER" ] || die "${PKG} 里没有 version 字段"

# 拆成「核心号 X.Y.Z」+「后缀计数器 N」：2.17.6-asulada.1 → 核心 2.17.6、N=1。
# 上游原样的 2.17.5（没有后缀）N 视为 0：第一次 patch/minor/major 就从 -asulada.1 起。
CORE="${CUR_VER%%-*}"
SUF=""
if [ "$CUR_VER" != "$CORE" ]; then
  PRE="${CUR_VER#"$CORE"-}"
  case "$PRE" in
    "$STEM".*) SUF="${PRE#"$STEM".}" ;;
    *) die "${PKG} 的版本后缀是 ${PRE}，不是本仓的 ${STEM}.N（要按上游口径发版请用上游脚本）" ;;
  esac
fi
case "$CORE" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) die "${PKG} 里的版本核心号不是 X.Y.Z：${CUR_VER}" ;;
esac
case "${SUF:-0}" in
  *[!0-9]*) die "后缀计数器不是整数：${CUR_VER}" ;;
esac

LAST_TAG="$(git tag --list 'v[0-9]*' --sort=-v:refname | head -n1 || true)"

bump_core() { # $1=X.Y.Z  $2=级别
  local M m p
  IFS=. read -r M m p <<<"$1"
  case "$2" in
    major) echo "$((M + 1)).0.0" ;;
    minor) echo "$M.$((m + 1)).0" ;;
    patch) echo "$M.$m.$((p + 1))" ;;
  esac
}

case "$LEVEL" in
  rev)
    [ -n "$SUF" ] || die "当前版本 ${CUR_VER} 还没有后缀，第一次发版请用 patch/minor/major（会从 -${STEM}.1 起）"
    NEW_VER="${CORE}-${STEM}.$((SUF + 1))"
    REASON="核心号不动，后缀计数器 ${SUF} 抬到 $((SUF + 1))"
    ;;
  *)
    NEW_CORE="$(bump_core "$CORE" "$LEVEL")"
    NEW_VER="${NEW_CORE}-${STEM}.1"
    REASON="核心号 ${CORE} 抬到 ${NEW_CORE}（${LEVEL} +1），后缀计数器归 1"
    ;;
esac
NEW_TAG="v$NEW_VER"

say "当前：package.json ${CUR_VER} ｜最近 tag：${LAST_TAG:-无}"
say "算法：${REASON}"
say "目标：${NEW_VER} ｜ tag ${NEW_TAG} ｜ 分支 ${BRANCH}"

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

# 只推 tag。分支（${BRANCH}）由你自己推 —— 脚本把这次版本号提交留在本地，等你 push 分支时
# 一起上去。这样「什么时候发版」由人决定：先 push 分支等 ci.yml 绿，再回来跑本脚本。
if [ "${PUSH_TAG}" = "1" ]; then
  say "推 tag ${NEW_TAG} …（tag 那趟会跑 pnpm pack，把 tgz 挂上 GitHub Release）"
  git push origin "$NEW_TAG"
else
  warn "PUSH_TAG=0：tag ${NEW_TAG} 只在本机，没推。要发版时自己跑：git push origin ${NEW_TAG}"
fi

REMOTE_URL="$(git remote get-url origin 2>/dev/null || echo '')"
SLUG="$(printf '%s' "$REMOTE_URL" | sed -E 's#.*[:/]([^/:]+/[^/:]+?)(\.git)?$#\1#')"

# 分支落后就明说：tag 已经指到这个提交上了，但 origin 的 main 还没走到它。
if git rev-parse --verify --quiet "origin/$BRANCH" >/dev/null 2>&1; then
  AHEAD="$(git rev-list --count "origin/$BRANCH..HEAD" 2>/dev/null || echo 0)"
  if [ "${AHEAD:-0}" -gt 0 ]; then
    warn "origin/$BRANCH 比本地少 $AHEAD 个提交（含这次版本号提交）；本脚本不推分支，记得自己 git push origin $BRANCH"
  fi
fi

if [ "${PUSH_TAG}" = "1" ]; then
  say "tag 推完了。看进度：https://github.com/${SLUG}/actions"
  say "Release 会落在：https://github.com/${SLUG}/releases/tag/${NEW_TAG}"
  say "分工：分支那趟跑 pnpm check（你自己推触发），tag 那趟 pnpm pack + 发版。"
else
  say "一个字节都没推。要发版就先把分支推上去让 ci.yml 绿，再 git push origin ${NEW_TAG}"
  say "Release 会落在：https://github.com/${SLUG}/releases/tag/${NEW_TAG}"
fi

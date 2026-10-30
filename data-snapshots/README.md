# InsurHOT 数据快照

当前快照位于 `2026-10-30_143230/`，对应北京时间 2026 年 10 月 30 日 14 时 32 分开始捕获的本地运行状态。数据库与本地采集、筛选、评分、回执、核验记录一起保存在 InsurHOT 私有仓库中。配套代码的未提交改动保存在 `source-worktree.patch`，可从 `manifest.json` 中的 `baseCommit` 重建，补丁重建后的代码树已校验。

快照包含 47,101 条材料、54,024 条修订、112 个信源、881 条分析、1,291 条发布记录、4,216 条模型回执和 1,407 条筛选设置记录。本地文件包包含 1,473 份运行与核验文件，实际范围和逐表行数见 `manifest.json`。

数据库使用 PostgreSQL 16 的 `pg_dump` 自定义格式，保留表结构、材料与修订、信源、模型回执、分析与发布结果、进度设置及队列。管理员登录会话数据不进入快照。环境文件、API 密钥、数据库密码、隧道配置、运行时二进制、依赖、图片缓存和旧数据库备份均未上传，本地记录中的凭据已移除。

数据库是一次一致性快照，本地文件按文件分别捕获，时间和 SHA-256 记在 `manifest.json` 中。采集与已授权处理继续运行，快照结束后产生的新数据需另行备份。未完成、失败和未知结果保留原状态，原始材料数不能作为已完成筛选或评分的数量。

每卷最多 40 MiB。`manifest.json` 记录各卷及完整文件的大小、SHA-256、数据库表行数与恢复验证结果。`database.dump.part*` 合并后得到数据库，`runtime-data.tar.gz.part*` 合并后得到以 `.data/` 为根的本地文件包。

## 校验与合并

在项目根目录用 Python 3 校验，或同时合并到一个尚不存在的目录。

```bash
python3 data-snapshots/restore.py data-snapshots/2026-10-30_143230
python3 data-snapshots/restore.py data-snapshots/2026-10-30_143230 --output /tmp/insurhot-restore-20261030
```

## 恢复

在对应源码基线的独立项目副本中应用补丁，即可重建捕获时的配套代码。补丁不会覆盖环境文件。

```bash
git apply data-snapshots/2026-10-30_143230/source-worktree.patch
```

使用 PostgreSQL 16 或兼容版本的客户端，先自行配置目标数据库连接环境，再恢复到新建空库。备份已含表结构，无需先向目标库执行迁移。

```bash
createdb insurhot_restore
pg_restore --no-owner --no-privileges --exit-on-error --dbname insurhot_restore /tmp/insurhot-restore-20261030/database.dump
```

在独立的项目副本中恢复本地文件，替换下面的项目路径。

```bash
tar -xzf /tmp/insurhot-restore-20261030/runtime-data.tar.gz -C /path/to/InsurHOT
```

连接凭据由使用者在本机重新配置。首次检查恢复结果时保持 `COLLECT_ENABLED=false`、`MODEL_CALLS_ENABLED=false`，推送与 IndexNow 阀保持关闭。检查已有回执、运行进度和未完成任务后，再决定恢复哪些处理，避免把旧任务重新计为新增授权。

## 代码检查记录

数据库恢复、分卷合并、SHA-256、凭据扫描与源码补丁重建均已通过。配套代码的类型检查、生产构建和 30 项站点冒烟检查通过，后端回归有 26 项失败与 1 项取消，网页测试观察到大纲断言失败后停止。检查状态写入 `validation.json`，完整已捕获日志位于 `validation/`。本次提交保存数据快照与代码补丁，工作区中的产品改动继续保留供后续修复和提交。

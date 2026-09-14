-- ============================================================
-- OAAM State DB Schema (v1, post-rebuild)
-- ============================================================
-- 真相源分层(GLOBAL_DBA_REVIEW §5 + STORAGE_AUTHORITY_MATRIX):
--   - Asset/Version/Project/Settings manifest 文件权威 (~/.oaam/...)
--   - Deployment state DB 权威 (本 schema 的 5 张 business state 表)
--   - Stage R internal crash authority (deployment_commit_receipts)
--   - current_asset_index / project_index / assets_fts 可重建投影
--
-- 全部时间字段统一 epoch milliseconds INTEGER(GLOBAL_DBA_REVIEW §5)。
-- authoritative state 表默认单列主键 + created_at/updated_at/deleted 治理字段；
-- deployment_render_snapshots 因同一fingerprint可跨Deployment重复，使用已批准的
-- owner-local复合主键但仍保留完整治理字段。
-- SQL 只守简单结构约束(NOT NULL/0-1/简单枚举/时间范围/业务 UNIQUE/必要 FK RESTRICT);
-- 跨表领域不变式、status 派生、JSON strict 校验归 core strict validator + 测试
-- (CORE_DATA_MODEL_DRAFT §8.12 + DESIGN_REVIEW_RETROSPECTIVE「不复制状态机进 CHECK」)。
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- ============================================================
-- 1. deployments — Deployment 当前关系、消费者意图、成功事务证明、
--    blocked evidence 的 authoritative state(GLOBAL_DBA_REVIEW §4.1)
-- ============================================================
-- deployment_id: UUID v4,由 core 生成,首次创建后稳定不变
-- 不存权威 status 列(status 由 core 纯函数派生,见 CORE_DATA_MODEL_DRAFT §8.10)
-- 不存 latest/current version 指针 / environment_key / adapter-runtime FK
CREATE TABLE IF NOT EXISTS deployments (
    deployment_id             TEXT    NOT NULL PRIMARY KEY,
    consumer_agent_runtime_ids TEXT   NOT NULL  -- strict JSON array,core validator 校验
        CHECK (json_valid(consumer_agent_runtime_ids)),
    platform                  TEXT    NOT NULL
        CHECK (platform IN ('win32', 'darwin', 'linux', 'wsl')),
    platform_instance_id      TEXT    NOT NULL
        CHECK (length(platform_instance_id) > 0),
    target_root_path          TEXT    NOT NULL,
    project_id                TEXT    NOT NULL,  -- global = "" ; project = Project UUID
    committed_transaction_id  TEXT    NOT NULL,  -- "" when none
    applied_inputs_snapshot   TEXT    NOT NULL  -- strict JSON object
        CHECK (json_valid(applied_inputs_snapshot)),
    applied_render_snapshot_ref TEXT  NOT NULL  -- strict never/applied pointer branch
        CHECK (json_valid(applied_render_snapshot_ref)),
    observation_state         TEXT    NOT NULL
        CHECK (observation_state IN ('never', 'in_progress', 'complete', 'partial', 'failed')),
    observation_attempted_at  INTEGER NOT NULL
        CHECK (observation_attempted_at >= 0),
    last_complete_observation_at INTEGER NOT NULL
        CHECK (
            last_complete_observation_at >= 0
            AND last_complete_observation_at <= observation_attempted_at
            AND (
                observation_state = 'in_progress'
                OR (observation_state = 'never' AND observation_attempted_at = 0 AND last_complete_observation_at = 0)
                OR (
                    observation_state = 'complete'
                    AND observation_attempted_at > 0
                    AND last_complete_observation_at = observation_attempted_at
                )
                OR (observation_state IN ('partial', 'failed') AND observation_attempted_at > 0)
            )
        ),
    blocking_evidence         TEXT    NOT NULL  -- strict JSON object;空值用 strict object 字段表达
        CHECK (json_valid(blocking_evidence)),
    deleted                   INTEGER NOT NULL DEFAULT 0
        CHECK (deleted IN (0, 1)),
    created_at                INTEGER NOT NULL
        CHECK (created_at >= 0),
    updated_at                INTEGER NOT NULL
        CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments(project_id);
CREATE INDEX IF NOT EXISTS idx_deployments_deleted ON deployments(deleted);

-- ============================================================
-- 2. deployment_assets — DeploymentAsset 当前输入关系
--    (GLOBAL_DBA_REVIEW §4.2)
-- ============================================================
-- deployment_asset_id = MD5("DeploymentAsset\0" + deployment_id + "\0" + asset_id)
--   由 core 生成,确定性,同关系 UPSERT 保留 id/createdAt
-- 不对 asset_id/version_id 建 SQL FK(manifest 权威,不依赖可重建 SQL 投影)
-- 同 Deployment 内 sortOrder 唯一只作用于 deleted=0 的 active 行(部分 UNIQUE index)
CREATE TABLE IF NOT EXISTS deployment_assets (
    deployment_asset_id   TEXT    NOT NULL PRIMARY KEY,
    deployment_id         TEXT    NOT NULL
        REFERENCES deployments(deployment_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    asset_id              TEXT    NOT NULL,
    version_id            TEXT    NOT NULL,
    sort_order            INTEGER NOT NULL
        CHECK (sort_order >= 0),
    allow_incomplete      INTEGER NOT NULL DEFAULT 0
        CHECK (allow_incomplete IN (0, 1)),
    deleted               INTEGER NOT NULL DEFAULT 0
        CHECK (deleted IN (0, 1)),
    created_at            INTEGER NOT NULL
        CHECK (created_at >= 0),
    updated_at            INTEGER NOT NULL
        CHECK (updated_at >= created_at),
    UNIQUE (deployment_id, asset_id)
);

-- partial UNIQUE:同 Deployment 内 active 行的 sortOrder 不可重复(tombstone 不占顺序)
CREATE UNIQUE INDEX IF NOT EXISTS idx_deployment_assets_sortorder_active
    ON deployment_assets(deployment_id, sort_order) WHERE deleted = 0;

CREATE INDEX IF NOT EXISTS idx_deployment_assets_asset ON deployment_assets(asset_id);

-- ============================================================
-- 3. deployment_files — DeploymentFile 最近成功文件基准 + 最近可信观测
--    (GLOBAL_DBA_REVIEW §4.3)
-- ============================================================
-- deployment_file_id = MD5("DeploymentFile\0" + deployment_id + "\0" + canonical_relative_path)
--   由 core 生成,确定性;路径移动产生新 ID,不承担跨路径逻辑血缘
-- 不存 byte size / MIME / content kind / raw-native path 副本
-- runtime 文件 missing 由 observed_state='missing' 表达,不自动等于 deleted=1
CREATE TABLE IF NOT EXISTS deployment_files (
    deployment_file_id     TEXT    NOT NULL PRIMARY KEY,
    deployment_id          TEXT    NOT NULL
        REFERENCES deployments(deployment_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    relative_path          TEXT    NOT NULL,  -- canonical POSIX relative;core validator 守
    baseline_state         TEXT    NOT NULL  -- strict active/removed JSON branch
        CHECK (json_valid(baseline_state)),
    observed_state         TEXT    NOT NULL
        CHECK (observed_state IN ('present', 'missing')),
    observed_content_hash  TEXT    NOT NULL,  -- present 时为 sha256:...,否则 ""
    observed_executable    INTEGER NOT NULL
        CHECK (observed_executable IN (0, 1)),
    observed_at            INTEGER NOT NULL
        CHECK (observed_at >= 0),  -- epoch millis; file-level never is represented by no row
    deleted                INTEGER NOT NULL DEFAULT 0
        CHECK (deleted IN (0, 1)),
    created_at             INTEGER NOT NULL
        CHECK (created_at >= 0),
    updated_at             INTEGER NOT NULL
        CHECK (updated_at >= created_at),
    UNIQUE (deployment_id, relative_path)
);

CREATE INDEX IF NOT EXISTS idx_deployment_files_deployment ON deployment_files(deployment_id);

-- ============================================================
-- 4. deployment_render_snapshots — immutable successful render decisions
-- ============================================================
CREATE TABLE IF NOT EXISTS deployment_render_snapshots (
    snapshot_fingerprint  TEXT    NOT NULL,
    deployment_id         TEXT    NOT NULL
        REFERENCES deployments(deployment_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    snapshot_json         TEXT    NOT NULL
        CHECK (json_valid(snapshot_json)),
    deleted               INTEGER NOT NULL DEFAULT 0
        CHECK (deleted IN (0, 1)),
    created_at            INTEGER NOT NULL
        CHECK (created_at >= 0),
    updated_at            INTEGER NOT NULL
        CHECK (updated_at = created_at),
    PRIMARY KEY (deployment_id, snapshot_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_deployment_render_snapshots_deployment
    ON deployment_render_snapshots(deployment_id);

-- ============================================================
-- 5. deployment_residual_authorities — immutable cumulative removed baselines
-- ============================================================
CREATE TABLE IF NOT EXISTS deployment_residual_authorities (
    residual_authority_id          TEXT    NOT NULL PRIMARY KEY,
    deployment_id                 TEXT    NOT NULL
        REFERENCES deployments(deployment_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    relative_path                 TEXT    NOT NULL,
    authority_body                TEXT    NOT NULL
        CHECK (json_valid(authority_body)),
    residual_authority_fingerprint TEXT   NOT NULL,
    deleted                       INTEGER NOT NULL DEFAULT 0
        CHECK (deleted IN (0, 1)),
    created_at                    INTEGER NOT NULL
        CHECK (created_at >= 0),
    updated_at                    INTEGER NOT NULL
        CHECK (updated_at = created_at)
);

CREATE INDEX IF NOT EXISTS idx_deployment_residual_authorities_deployment
    ON deployment_residual_authorities(deployment_id);

-- ============================================================
-- 6. deployment_commit_receipts — Stage R immutable commit proof
--    (GLOBAL_DBA_REVIEW §4.3.3)
-- ============================================================
-- 这是跨 Asset filesystem authority 与 Deployment DB success state 的
-- internal crash authority，不是业务 run/history 表。真实 join identity 就是
-- (deployment_id, commit_transaction_id)，因此不造可推导 row ID，也不保存
-- timestamp/deleted/revision。正常提交只能 plain INSERT；已存在 key 必须进入
-- Core recovery/classification 并 exact 比较，禁止 UPSERT/REPLACE。
CREATE TABLE IF NOT EXISTS deployment_commit_receipts (
    schema_version                         INTEGER NOT NULL
        CHECK (schema_version = 1),
    deployment_id                         TEXT    NOT NULL
        REFERENCES deployments(deployment_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    commit_transaction_id                 TEXT    NOT NULL,
    pre_commit_database_state_fingerprint TEXT    NOT NULL,
    applied_inputs_snapshot_fingerprint   TEXT    NOT NULL,
    applied_render_snapshot_fingerprint   TEXT    NOT NULL,
    deployment_file_baseline_set_fingerprint TEXT NOT NULL,
    commit_receipt_fingerprint            TEXT    NOT NULL,
    PRIMARY KEY (deployment_id, commit_transaction_id)
) WITHOUT ROWID;

-- ============================================================
-- 7. current_asset_index — Asset manifest + 当前 Version manifest 的可重建投影
--    (GLOBAL_DBA_REVIEW §4.4, PASS_WITH_SCOPE)
-- ============================================================
-- 这是衍生投影,不是 Asset 权威。DBA 治理字段(asset_id/created_at/updated_at/deleted)
-- 是 manifest 投影,不是独立 index row lifecycle。
-- reindex 可全量重建此表;失败不反向修改 manifest。
CREATE TABLE IF NOT EXISTS current_asset_index (
    asset_id                TEXT    NOT NULL PRIMARY KEY,
    kind                    TEXT    NOT NULL
        CHECK (kind IN ('Guidance', 'Rule', 'Workflow', 'Skill', 'Subagent', 'Memory')),
    scope                   TEXT    NOT NULL
        CHECK (scope IN ('global', 'project')),
    project_id              TEXT    NOT NULL,  -- global = ""
    scope_path              TEXT    NOT NULL,  -- global/项目根 = ""
    display_name            TEXT    NOT NULL,
    display_description     TEXT    NOT NULL,
    current_version_id      TEXT    NOT NULL,
    current_revision        INTEGER NOT NULL
        CHECK (current_revision >= 1),
    current_fingerprint     TEXT    NOT NULL,
    current_version_status  TEXT    NOT NULL
        CHECK (current_version_status IN ('complete', 'incomplete')),
    created_at              INTEGER NOT NULL  -- projected Asset manifest createdAt
        CHECK (created_at >= 0),
    updated_at              INTEGER NOT NULL  -- projected Asset manifest updatedAt
        CHECK (updated_at >= created_at),
    deleted                 INTEGER NOT NULL
        CHECK (deleted IN (0, 1)),
    -- global 组合不变式:scope='global' 时 project_id 和 scope_path 必须为空。
    -- (project 组合不变式 — projectId UUID 校验、scope/project 匹配 — 由 core validator 守,
    --  不复制进 SQL;这里只守 global 空组合。)
    CHECK (
        (scope = 'global'  AND project_id = '' AND scope_path = '')
        OR scope = 'project'
    )
);

CREATE INDEX IF NOT EXISTS idx_current_asset_kind ON current_asset_index(kind);
CREATE INDEX IF NOT EXISTS idx_current_asset_scope_project ON current_asset_index(scope, project_id);
CREATE INDEX IF NOT EXISTS idx_current_asset_deleted ON current_asset_index(deleted);

-- ============================================================
-- 8. project_index — Project manifest 的可重建投影(GLOBAL_DBA_REVIEW §4.6,可选)
-- ============================================================
-- Project 权威是 ~/.oaam/projects/<project-uuid>/project.json。
-- 本表只服务 listProjects 加速;Project 注册/删除/rebind 不得只写进 SQLite。
CREATE TABLE IF NOT EXISTS project_index (
    project_id    TEXT    NOT NULL PRIMARY KEY,
    root_path     TEXT    NOT NULL,
    display_name  TEXT    NOT NULL,  -- 允许 "";展示 fallback 由 core 派生,不回写
    deleted       INTEGER NOT NULL
        CHECK (deleted IN (0, 1)),
    created_at    INTEGER NOT NULL
        CHECK (created_at >= 0),
    updated_at    INTEGER NOT NULL
        CHECK (updated_at >= created_at)
);

-- ============================================================
-- 9. assets_fts — FTS5 全文索引(纯派生虚表,GLOBAL_DBA_REVIEW §4.5 PASS_EXEMPT)
-- ============================================================
-- 不适用单列业务主键 / created_at / updated_at / deleted(FTS 虚表例外)。
-- 不是灾备,不作为 Asset/Version 权威。
-- 由 reindex 全量重建(Step 6 实现);输入 = current_asset_index 对应的当前版本可搜索文本。
-- tokenize='trigram' 支持中文/混合关键字。
-- 维护策略:v1 选择 reindex-only(无 external-content 关联、无同步触发器)。reindex 通过
-- `DELETE FROM assets_fts; INSERT INTO assets_fts ...` 全量重建,不使用先删后插的 REPLACE
-- 变体(避免破坏软删除语义)。若 Step 6 实现期发现增量维护有真实性能需求,可再单独评估触发器方案。
CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(
    asset_id UNINDEXED,
    display_name,
    display_description,
    searchable_text,
    tokenize = 'trigram'
);

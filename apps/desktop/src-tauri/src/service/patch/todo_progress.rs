//! todo 进度补丁：让「任务」面板不再长期停在「第一项进行中」。
//!
//! 上游 `dsh-tool-todo` 的 `todos` 投影只认 `todo/write` 与 `turn/start`，`turn/end`
//! 不改变状态——回合早已结束，面板仍报「1 进行中」，直到下一个回合开始才被清空
//! （上游 Discussions #11956）。同时上游 `321a6fa740` 把「完成即刻回写、不要攒到最后
//! 一并标记」从工具描述里删掉，模型于是整段回合只写一次清单，面板显示的进度与实际
//! 工作脱节（#6458 / #8492）。
//!
//! 本补丁做两处最小改动：
//! 1. 投影 `apply` 在 `turn/end` 把残留的 `in_progress` 降级为 `pending`（#11956 方案 A），
//!    并同步把 `stateVersion` 从 2 抬到 3，让旧缓存行作废后按新语义重折；
//! 2. 工具描述补回「完成即刻标记、逐项推进」的要求，引导模型在回合内持续回写清单。
//!
//! 幂等与容错：两处各自带标记，已打过即跳过；任一锚点因上游布局变更而缺失 → 跳过并告警，
//! 不阻断启动（面板退级为上游原状，不会更差）。

use std::path::Path;

use crate::utils::{patch_core_file, patch_dsh, PatchOutcome};

/// 相对活动核心安装目录的 todo 工具包内路径。
const TOOL_TODO_LIB: &str = "node_modules/@deepseek-ai/dsh-tool-todo/lib/index.js";

/// 投影折叠处的幂等标记（与 `stateVersion` 一起出现，代表「turn/end 降级」已生效）。
const FOLD_MARKER: &str = "/* dsh-tauri: settle todos on turn/end */";

/// 投影折叠处锚点：`todo/write` 与 `turn/start` 两条最稳定的判定行。
const FOLD_ANCHOR: &str = "\t\t\tif (event.type === \"todo/write\") return event.data.todos;\n\t\t\tif (event.type === \"turn/start\") return null;\n";

/// 状态版本锚点与替换（语义变了就必须抬版本，否则旧缓存行会被当成新语义复用）。
const STATE_VERSION_ANCHOR: &str = "\t\tstateVersion: 2";
const STATE_VERSION_PATCHED: &str = "\t\tstateVersion: 3 /* dsh-tauri: settle todos on turn/end */";

/// 工具描述尾句的幂等标记。
const DESC_MARKER: &str = "/* dsh-tauri: keep the todo list tracking real progress */";

/// 工具描述尾句锚点（上游删掉反批量约束后就是这一句）。
const DESC_ANCHOR: &str =
    "const DESCRIPTION_TAIL = \"Mark each todo `completed` as soon as it is done.\";";

/// 补丁后的尾句：恢复「完成即刻标记 + 逐项推进」的要求。
const DESC_PATCHED: &str = "const DESCRIPTION_TAIL = \"Mark each todo `completed` the moment it is done, never batch completions; rewrite the whole list after every finished todo so the in-progress item is always the task being worked on right now.\"; /* dsh-tauri: keep the todo list tracking real progress */";

/// 幂等补丁逻辑的纯函数部分（便于单测，不触碰文件系统）。
fn patch_source(source: &str) -> PatchOutcome {
    let needs_fold = !source.contains(FOLD_MARKER);
    let needs_description = !source.contains(DESC_MARKER);
    if !needs_fold && !needs_description {
        return PatchOutcome::AlreadyPatched;
    }
    let mut patched = source.to_string();
    if needs_fold {
        if !patched.contains(FOLD_ANCHOR) || !patched.contains(STATE_VERSION_ANCHOR) {
            return PatchOutcome::AnchorMissing;
        }
        patched = patched.replacen(
            FOLD_ANCHOR,
            &format!(
                "{FOLD_ANCHOR}\t\t\tif (event.type === \"turn/end\" && Array.isArray(state) && state.some((todo) => todo.status === \"in_progress\")) return state.map((todo) => todo.status === \"in_progress\" ? {{ content: todo.content, status: \"pending\" }} : todo); {FOLD_MARKER}\n"
            ),
            1,
        );
        patched = patched.replacen(STATE_VERSION_ANCHOR, STATE_VERSION_PATCHED, 1);
    }
    if needs_description {
        if !patched.contains(DESC_ANCHOR) {
            return PatchOutcome::AnchorMissing;
        }
        patched = patched.replacen(DESC_ANCHOR, DESC_PATCHED, 1);
    }
    PatchOutcome::Patched(patched)
}

/// 对显式给定的核心安装目录施加本补丁（E2E 编排复用，无需运行中的桌面端）。
pub fn apply_at(core_dir: &Path) -> Result<(), String> {
    patch_core_file(core_dir, TOOL_TODO_LIB, patch_source)
}

pub fn apply(app_handle: &crate::AppHandle) -> Result<(), String> {
    patch_dsh(app_handle, TOOL_TODO_LIB, patch_source)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 官方 0.2.1-rc.5 产物中与本补丁相关的原始片段（tab 缩进）。
    fn fixture() -> String {
        format!(
            "const DESCRIPTION_HEAD = \"Record and update a task list to plan multi-step work and show progress; skip it for trivial single-step tasks. Add one todo per concrete step before you start. \";\n{DESC_ANCHOR}\n\tctx.sessionProjections.register({{\n\t\tkey: \"todos\",\n\t\tinit: () => null,\n\t\tapply: (state, event) => {{\n{FOLD_ANCHOR}\t\t\treturn state;\n\t\t}},\n{STATE_VERSION_ANCHOR}\n\t}});\n"
        )
    }

    #[test]
    fn patches_fold_version_and_description() {
        let PatchOutcome::Patched(patched) = patch_source(&fixture()) else {
            panic!("expected Patched");
        };
        assert!(patched.contains("event.type === \"turn/end\" && Array.isArray(state)"));
        assert!(patched.contains(FOLD_MARKER));
        assert!(patched.contains("stateVersion: 3"));
        assert!(!patched.contains(STATE_VERSION_ANCHOR));
        assert!(patched.contains(DESC_PATCHED));
        assert!(!patched.contains(DESC_ANCHOR));
        assert_eq!(patch_source(&patched), PatchOutcome::AlreadyPatched);
    }

    #[test]
    fn skips_when_anchor_missing() {
        assert_eq!(
            patch_source("const something = 1;\n"),
            PatchOutcome::AnchorMissing
        );
    }
}

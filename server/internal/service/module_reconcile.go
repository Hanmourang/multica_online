package service

import (
	"sort"
	"strings"
)

// 功能模块原型中枢的对账「唯一口径」（plans/20261026 07 §2.4 · M-05）。
//
// 前后端必须共用这一套判定：列表徽标、详情覆盖率环、对账矩阵 KPI 全部源自此函数，
// 前端仅在无网络时用同构 TS 版降级（见 07 §3.5「不允许前端自己再算一遍做展示」）。
// 本文件为纯函数，不触库、不依赖 handler，便于表驱动单测与 Go/TS 双端对齐。

// ModuleSpecFeature 是 module_spec/v1 里的一个功能点（07 附录 B）。
// Group 是右栏「功能点清单」的分组标签（原型区块，如「浏览」「分析」）；
// 可为空，空则归入同一个未分组桶。发布时原样往返，不在服务端重算。
type ModuleSpecFeature struct {
	Code     string `json:"code"`
	Title    string `json:"title"`
	Kind     string `json:"kind"`
	Priority string `json:"priority,omitempty"`
	Group    string `json:"group,omitempty"`
}

// ModuleSpec 是 project_module.spec 的反序列化目标（schema=module_spec/v1）。
type ModuleSpec struct {
	Schema   string              `json:"schema"`
	Summary  string              `json:"summary,omitempty"`
	Features []ModuleSpecFeature `json:"features"`
}

// ProtoAnchor 是某个功能点在当前预览版本里命中 data-fp 的结果。
type ProtoAnchor struct {
	Count int    `json:"count"`
	Title string `json:"title,omitempty"`
}

// ParsedPrototype 是前端解析 HTML 后回传的锚点映射（后端不解析 HTML，07 §2.3-4）。
type ParsedPrototype struct {
	Anchors map[string]ProtoAnchor `json:"anchors"`
}

// ReconcileState 是四态 + 独立 deprecated（07 D-C）。
type ReconcileState string

const (
	StateCovered      ReconcileState = "covered"      // 已覆盖
	StateChanged      ReconcileState = "changed"      // 待覆盖（标题漂移）
	StateMissing      ReconcileState = "missing"      // 空位（规格有·原型无）
	StateUnregistered ReconcileState = "unregistered" // 待登记（原型有·规格无）
	StateDeprecated   ReconcileState = "deprecated"   // 已废弃（不计入分母）
)

// Decision 是功能点处置（07 §2.5），存于合并计划快照，不直接改状态。
type Decision string

const (
	DecisionKeep      Decision = "keep"
	DecisionOverride  Decision = "override"
	DecisionDeprecate Decision = "deprecate"
	DecisionAdd       Decision = "add"
	DecisionSkip      Decision = "skip"
)

// ReconcileRow 是矩阵的一行（07 §2.4）。
type ReconcileRow struct {
	Code            string         `json:"code"`
	Title           string         `json:"title"`
	SpecTitle       string         `json:"specTitle,omitempty"` // changed 时 = 规格旧标题
	Kind            string         `json:"kind"`
	State           ReconcileState `json:"state"`
	PrototypeAnchor int            `json:"prototypeAnchor,omitempty"`
	RequirementID   string         `json:"requirementId,omitempty"`
	Owner           string         `json:"owner,omitempty"`
	Decision        Decision       `json:"decision,omitempty"`
}

// Coverage 是 f4 五个 KPI 的聚合（07 §3.5，唯一口径）。
type Coverage struct {
	Total        int     `json:"total"`        // 规格功能点总数
	Deprecated   int     `json:"deprecated"`   // 已废弃（出分母）
	Covered      int     `json:"covered"`      // 分子
	Changed      int     `json:"changed"`      // 待覆盖
	Missing      int     `json:"missing"`      // 空位（红）
	Unregistered int     `json:"unregistered"` // 待登记（蓝）
	Denominator  int     `json:"denominator"`  // total - deprecated
	Rate         float64 `json:"rate"`         // covered / denominator
}

// normalizeTitle 去首尾空白、转小写、折叠内部连续空白，用于「标题是否漂移」判定。
func normalizeTitle(s string) string {
	return strings.Join(strings.Fields(strings.ToLower(strings.TrimSpace(s))), " ")
}

// Reconcile 以规格功能点为行（D-B），叠加原型锚点做四态判定，并汇总覆盖率。
// decisions 可为 nil；键为功能点 code。
func Reconcile(spec ModuleSpec, proto ParsedPrototype, decisions map[string]Decision) ([]ReconcileRow, Coverage) {
	rows := make([]ReconcileRow, 0, len(spec.Features)+len(proto.Anchors))
	seen := make(map[string]bool, len(spec.Features))

	// 1) 行 = 规格功能点全集（D-B：否则「空位」永远不可见）。
	for _, f := range spec.Features {
		code := strings.TrimSpace(f.Code)
		seen[code] = true
		anchor, inProto := proto.Anchors[code]
		hit := inProto && anchor.Count > 0
		dec := decisions[code]

		var state ReconcileState
		switch {
		case dec == DecisionDeprecate && !hit:
			// 被显式废弃且原型已无 → deprecated（2.4 步 5，出分母）。
			state = StateDeprecated
		case !hit:
			// 命中判定：锚点缺失或 count==0 → 空位（2.4 步 2）。
			state = StateMissing
		case normalizeTitle(f.Title) != normalizeTitle(anchor.Title):
			// 标题差异 → 待覆盖（2.4 步 3）。
			state = StateChanged
		default:
			state = StateCovered
		}

		row := ReconcileRow{Code: code, Kind: f.Kind, State: state, Decision: dec}
		if hit {
			// 命中态以原型展示名为准，规格名保留为 specTitle 供「待覆盖」并排比对。
			row.Title = anchor.Title
			row.SpecTitle = f.Title
			row.PrototypeAnchor = anchor.Count
		} else {
			row.Title = f.Title
		}
		rows = append(rows, row)
	}

	// 2) 原型有、规格无 → unregistered（2.4 步 4，方向与 missing 相反）。排序保证输出稳定。
	extra := make([]string, 0, len(proto.Anchors))
	for code, anchor := range proto.Anchors {
		if seen[code] || anchor.Count <= 0 {
			continue
		}
		extra = append(extra, code)
	}
	sort.Strings(extra)
	for _, code := range extra {
		anchor := proto.Anchors[code]
		rows = append(rows, ReconcileRow{
			Code:            code,
			Title:           anchor.Title,
			State:           StateUnregistered,
			PrototypeAnchor: anchor.Count,
			Decision:        decisions[code],
		})
	}

	cov := Coverage{Total: len(spec.Features)}
	for _, r := range rows {
		switch r.State {
		case StateCovered:
			cov.Covered++
		case StateChanged:
			cov.Changed++
		case StateMissing:
			cov.Missing++
		case StateUnregistered:
			cov.Unregistered++
		case StateDeprecated:
			cov.Deprecated++
		}
	}
	// 3) 覆盖率 = covered ÷ (总数 - deprecated)（07 §3.5，唯一口径）。
	cov.Denominator = cov.Total - cov.Deprecated
	if cov.Denominator > 0 {
		cov.Rate = float64(cov.Covered) / float64(cov.Denominator)
	}
	return rows, cov
}

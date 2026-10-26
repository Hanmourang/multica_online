// Phase A/B 契约补全的单测（plan 20261025 §9.3 B-1/B-2/B-3a/B-3b）。
//
// 全部为纯函数/伪句柄测试，不触库：PG 不可达时也不会静默 skip 造成假绿。
package service

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/featureflags"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/featureflag"
)

// assetGateTestFlags 构造一个「资产门禁已开启」的 flag 服务（仓库既有范式：
// StaticProvider + Rule{Default}），供 ReevaluateInstance 的状态机分支测试使用。
func assetGateTestFlags(enabled bool) *featureflag.Service {
	provider := featureflag.NewStaticProvider()
	provider.Set(featureflags.WorkflowAssetGate, featureflag.Rule{Default: enabled})
	return featureflag.NewService(provider)
}

// ── B-1 spec 透传 ───────────────────────────────────────────────────────────

func TestFlattenCarriesStageSpec(t *testing.T) {
	raw := []byte(`{
      "schemaVersion": 1,
      "kind": "coco.workflow.template",
      "nodes": [
        {"kind":"stage","id":"s1","name":"拆解","mode":"auto","roleId":"a1",
         "goal":"产出可执行拆解","criteria":"每个子任务都有验收标准",
         "inputTpl":"需求：${workitem.title}","outputTpl":"markdown 拆解清单",
         "inputs":[{"fromStageId":"","outputName":"architecture","required":true,"assetRole":"in"}],
         "outputs":[{"id":"o1","name":"breakdown","type":"markdown"}]},
        {"kind":"stage","id":"s2","name":"验收","mode":"human_loop"}
      ]
    }`)
	def, err := ParseWorkflowDefinition(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	flat, err := def.Flatten()
	if err != nil {
		t.Fatalf("flatten: %v", err)
	}
	if len(flat) != 2 {
		t.Fatalf("want 2 nodes, got %d", len(flat))
	}
	spec := flat[0].Spec
	if spec == nil {
		t.Fatal("s1 spec must be carried into the engine node (B-1 regression)")
	}
	if spec.Goal != "产出可执行拆解" || spec.Criteria != "每个子任务都有验收标准" ||
		spec.InputTpl != "需求：${workitem.title}" || spec.OutputTpl != "markdown 拆解清单" {
		t.Fatalf("spec fields mismatched: %+v", spec)
	}
	// 无 spec 字段的阶段必须保持 nil，nodes JSON 形状与改造前逐字一致。
	if flat[1].Spec != nil {
		t.Fatalf("bare stage must have nil spec, got %+v", flat[1].Spec)
	}
	out, err := json.Marshal(flat)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), `"spec":null`) {
		t.Fatalf("nil spec must be omitted from nodes json, got %s", out)
	}
}

func TestFlattenGateCarriesLabels(t *testing.T) {
	raw := []byte(`{
      "schemaVersion": 1, "kind": "coco.workflow.template",
      "nodes": [
        {"kind":"iteration","id":"it1","name":"迭代","gate":{"id":"g1","loopLabel":"再来一轮","exitLabel":"结束迭代"},
         "children":[{"kind":"stage","id":"s1","name":"执行","mode":"auto"}]}
      ]
    }`)
	def, err := ParseWorkflowDefinition(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	flat, err := def.Flatten()
	if err != nil {
		t.Fatalf("flatten: %v", err)
	}
	var gate *WorkflowNode
	for i := range flat {
		if flat[i].ID == "g1" {
			gate = &flat[i]
		}
	}
	if gate == nil {
		t.Fatal("gate node missing after flatten")
	}
	if gate.Spec == nil || gate.Spec.LoopLabel != "再来一轮" || gate.Spec.ExitLabel != "结束迭代" {
		t.Fatalf("gate labels must reach the snapshot (B-4): %+v", gate.Spec)
	}
}

func TestParseStageSpecTreatsEmptyAsNil(t *testing.T) {
	cases := []struct {
		name string
		raw  []byte
		want bool
	}{
		{"nil", nil, false},
		{"empty", []byte(""), false},
		{"invalid", []byte("{"), false},
		{"all empty fields", []byte(`{}`), false},
		{"only goal", []byte(`{"goal":"g"}`), true},
		{"only labels", []byte(`{"loopLabel":"loop"}`), true},
	}
	for _, tc := range cases {
		got := parseStageSpec(tc.raw)
		if tc.want && got == nil {
			t.Errorf("%s: want spec, got nil", tc.name)
		}
		if !tc.want && got != nil {
			t.Errorf("%s: want nil, got %+v", tc.name, got)
		}
	}
}

// ── B-2 占位符渲染 ──────────────────────────────────────────────────────────

func TestRenderStageTemplatePlaceholders(t *testing.T) {
	rc := renderContextOf(RenderInputs{
		ProjectID: "11111111-1111-1111-1111-111111111111",
		Inputs: []DefinitionInput{
			{FromStageID: "s1", OutputID: "o1", OutputName: "prototype"},
			{OutputName: "architecture"},
		},
		Workitem: map[string]string{"title": "登录改版", "goal": "提升转化"},
	})
	cases := []struct {
		name         string
		tpl          string
		want         string
		wantWarnings []string
	}{
		{"workitem title", "标题：${workitem.title}", "标题：登录改版", nil},
		{"workitem unknown key", "${workitem.creator}", "${workitem.creator}", []string{"workitem.creator"}},
		{"inputs upstream pointer", "输入：${inputs.prototype}", "输入：stage_run:s1#o1", nil},
		{"inputs external asset pointer", "输入：${inputs.architecture}", "输入：asset:architecture", nil},
		{"inputs unknown", "${inputs.nope}", "${inputs.nope}", []string{"inputs.nope"}},
		{"project assets", "${project.assets}",
			"项目资产（project_id=11111111-1111-1111-1111-111111111111）：用 multica-assets MCP 的 assets_list / assets_search / assets_get_content(bindingId) 按需拉取", nil},
		{"unknown namespace", "${other.thing}", "${other.thing}", []string{"other.thing"}},
		{"dedupe repeated unknown", "${a.b} 与 ${a.b}", "${a.b} 与 ${a.b}", []string{"a.b"}},
		{"multiple keys one line", "${workitem.title} / ${workitem.goal}", "登录改版 / 提升转化", nil},
		{"empty tpl", "", "", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, warnings := renderStageTemplate(tc.tpl, rc)
			if got != tc.want {
				t.Errorf("render mismatch:\n got=%q\nwant=%q", got, tc.want)
			}
			if len(tc.wantWarnings) == 0 {
				if len(warnings) != 0 {
					t.Errorf("want no warnings, got %v", warnings)
				}
				return
			}
			if !reflect.DeepEqual(warnings, tc.wantWarnings) {
				t.Errorf("warnings mismatch: got=%v want=%v", warnings, tc.wantWarnings)
			}
		})
	}
}

func TestRenderContextWithoutProjectOmitsAssets(t *testing.T) {
	rc := renderContextOf(RenderInputs{})
	if rc.AssetsRef != "" {
		t.Fatalf("zero project must not advertise asset pull, got %q", rc.AssetsRef)
	}
	if _, ok := lookupStagePlaceholder("project.assets", rc); ok {
		t.Fatal("project.assets must be unresolved without a project")
	}
}

func TestComposeSpecPromptSections(t *testing.T) {
	rc := renderContextOf(RenderInputs{
		Inputs:   []DefinitionInput{{FromStageID: "s1", OutputID: "o1", OutputName: "prototype"}},
		Workitem: map[string]string{"title": "T"},
	})
	spec := &StageSpec{
		Goal:      "完成原型",
		Criteria:  "评审通过",
		InputTpl:  "读 ${inputs.prototype}",
		OutputTpl: "产出 ${workitem.title} 的可交互稿",
	}
	out, warnings := composeSpecPrompt("基础正文", spec, rc)
	if len(warnings) != 0 {
		t.Fatalf("unexpected warnings: %v", warnings)
	}
	want := "基础正文\n\n## 阶段目标\n完成原型\n\n## 达成判定\n评审通过\n\n## 输入资产\n读 stage_run:s1#o1\n\n## 交付要求\n产出 T 的可交互稿"
	if out != want {
		t.Errorf("section composition mismatch:\n got=%q\nwant=%q", out, want)
	}
	// nil spec 必须逐字返回 base（旧快照零回归路径）。
	base, w2 := composeSpecPrompt("旧阶段", nil, rc)
	if base != "旧阶段" || w2 != nil {
		t.Errorf("nil spec must be a no-op, got %q / %v", base, w2)
	}
	// 空字段不得留下空小节。
	only, _ := composeSpecPrompt("x", &StageSpec{Goal: "  "}, rc)
	if only != "x" {
		t.Errorf("blank goal must be skipped, got %q", only)
	}
}

// ── B-3a 准入按来源分流 ─────────────────────────────────────────────────────

func TestAdmissionMissingSplitsUpstreamAndExternal(t *testing.T) {
	required := []DefinitionInput{
		{FromStageID: "s1", OutputName: "prototype", Required: true},
		{OutputName: "architecture", Required: true},
		{OutputName: "prototype", Required: true}, // 同名去重
		{OutputName: "optional-doc"},              // 非必检，不参与判定
	}
	bound := map[string]bool{"architecture": true}
	missing, err := admissionMissingWith(required, map[string]bool{}, func(name string) (bool, error) {
		return bound[name], nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(missing, []string{"prototype"}) {
		t.Fatalf("want only upstream-produced missing, got %v", missing)
	}

	// 上游产出后：上游型满足；外部项未绑定仍缺。
	bound["architecture"] = false
	missing2, err := admissionMissingWith(required, map[string]bool{"prototype": true},
		func(name string) (bool, error) { return false, nil })
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(missing2, []string{"architecture"}) {
		t.Fatalf("want external missing only, got %v", missing2)
	}

	// 上游型绝不回退到绑定判定：即便资产模块里有同名 prototype，也仍算缺件。
	missing3, err := admissionMissingWith(required, map[string]bool{},
		func(string) (bool, error) { return true, nil })
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(missing3, []string{"prototype"}) {
		t.Fatalf("upstream-typed input must not be satisfied by bindings, got %v", missing3)
	}

	// 判定器缺失（无原生句柄）时保守阻塞，不放行。
	missing4, err := admissionMissingWith(required, map[string]bool{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(missing4) != 2 {
		t.Fatalf("nil resolver must keep both blocked, got %v", missing4)
	}

	// 解析错误上抛（由调用方保守处理），不得吞掉。
	if _, err := admissionMissingWith(required, nil, func(string) (bool, error) {
		return false, errors.New("db down")
	}); err == nil {
		t.Fatal("resolver error must propagate")
	}
}

func TestRequiredAssetsAndNamesIgnoreOutRole(t *testing.T) {
	raw := []byte(`[
      {"outputName":"a","required":true},
      {"outputName":"b","required":true,"assetRole":"out"},
      {"outputName":"c"},
      {"outputId":"d-id","required":true}
    ]`)
	if got := requiredAssetNames(raw); !reflect.DeepEqual(got, []string{"a", "d-id"}) {
		t.Fatalf("requiredAssetNames mismatch: %v", got)
	}
	items := requiredAssets(raw)
	if len(items) != 2 || items[0].OutputName != "a" || items[1].OutputID != "d-id" {
		t.Fatalf("requiredAssets must keep full structure for role routing: %+v", items)
	}
	if requiredAssets([]byte("not json")) != nil {
		t.Fatal("invalid json must yield nil, not panic")
	}
}

// ── B-3b 产物落地 SQL ───────────────────────────────────────────────────────

func TestArtifactBindingSQLPicksConflictTargetPerScope(t *testing.T) {
	issueID := pgtype.UUID{Bytes: [16]byte{1}, Valid: true}
	inst := db.WorkflowInstance{
		WorkspaceID:   pgtype.UUID{Bytes: [16]byte{2}, Valid: true},
		ProjectID:     pgtype.UUID{Bytes: [16]byte{3}, Valid: true},
		RootIssueID:   issueID,
		StartedByType: "member",
		StartedByID:   pgtype.UUID{Bytes: [16]byte{4}, Valid: true},
	}
	q, args := artifactBindingSQL(inst, "prototype", `{"output_id":"o1"}`)
	if !strings.Contains(q, "ON CONFLICT (issue_id, asset_category, asset_name, source) WHERE issue_id IS NOT NULL") {
		t.Fatalf("issue-level binding must target the issue partial index:\n%s", q)
	}
	if !strings.Contains(q, "'workflow', 'output'") {
		t.Fatalf("binding must be tagged source=workflow / asset_role=output:\n%s", q)
	}
	if len(args) != 7 {
		t.Fatalf("want 7 bind args, got %d", len(args))
	}
	if got, ok := args[2].(pgtype.UUID); !ok || got != issueID {
		t.Errorf("issue slot must carry root issue id, got %#v", args[2])
	}

	inst.RootIssueID = pgtype.UUID{} // 无 root issue → 项目级绑定
	q2, _ := artifactBindingSQL(inst, "prototype", `{}`)
	if !strings.Contains(q2, "ON CONFLICT (project_id, asset_category, asset_name, source) WHERE issue_id IS NULL") {
		t.Fatalf("project-level binding must target the project partial index:\n%s", q2)
	}
}

// ── B-3c 无原生句柄时的保守降级 ─────────────────────────────────────────────

func TestBindingSatisfiesAssetWithoutHandleIsConservative(t *testing.T) {
	svc := &WorkflowService{} // db 未注入（老构造路径/单测）
	ok, err := svc.bindingSatisfiesAsset(context.Background(),
		pgtype.UUID{Bytes: [16]byte{1}, Valid: true}, pgtype.UUID{}, "architecture")
	if err != nil {
		t.Fatalf("must not error without a handle, got %v", err)
	}
	if ok {
		t.Fatal("without a DB handle the check must report unsatisfied (never unblock on guess)")
	}
}

func TestReevaluateIsNoOpWhenGateOff(t *testing.T) {
	svc := &WorkflowService{db: &fakeRawDB{}}
	// FeatureFlags 为 nil → assetGateEnabled=false → 复评必须整体 no-op（零回归）。
	n, err := svc.ReevaluateProjectBlocked(context.Background(), pgtype.UUID{})
	if err != nil || n != 0 {
		t.Fatalf("flag off must short-circuit, got n=%d err=%v", n, err)
	}
	if err := svc.ReevaluateInstance(context.Background(), db.WorkflowInstance{Status: "running"}); err != nil {
		t.Fatalf("flag off ReevaluateInstance must be nil, got %v", err)
	}
	// 开 flag 但实例非 running → 状态机约束优先，返回冲突。
	svcOn := &WorkflowService{db: &fakeRawDB{}, FeatureFlags: assetGateTestFlags(true)}
	if err := svcOn.ReevaluateInstance(context.Background(), db.WorkflowInstance{Status: "done"}); !errors.Is(err, ErrWorkflowConflict) {
		t.Fatalf("non-running instance must conflict, got %v", err)
	}
}

// fakeRawDB 只实现本文件测试所需行为：EXISTS 查询回指定的 exists 值。
type fakeRawDB struct {
	exists  bool
	scanErr error
}

func (f *fakeRawDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.NewCommandTag("INSERT 0 1"), nil
}

func (f *fakeRawDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("unused in tests")
}

func (f *fakeRawDB) QueryRow(context.Context, string, ...any) pgx.Row {
	return fakeRow{exists: f.exists, scanErr: f.scanErr}
}

type fakeRow struct {
	exists  bool
	scanErr error
}

func (r fakeRow) Scan(dest ...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	if len(dest) != 1 {
		return errors.New("expected exactly one scan dest")
	}
	target, ok := dest[0].(*bool)
	if !ok {
		return errors.New("scan dest must be *bool")
	}
	*target = r.exists
	return nil
}

func TestBindingSatisfiesAssetWithHandle(t *testing.T) {
	svcBound := &WorkflowService{db: &fakeRawDB{exists: true}}
	ok, err := svcBound.bindingSatisfiesAsset(context.Background(),
		pgtype.UUID{Bytes: [16]byte{1}, Valid: true}, pgtype.UUID{}, "architecture")
	if err != nil || !ok {
		t.Fatalf("bound asset must satisfy, got ok=%v err=%v", ok, err)
	}
	svcErr := &WorkflowService{db: &fakeRawDB{scanErr: errors.New("boom")}}
	if _, err := svcErr.bindingSatisfiesAsset(context.Background(),
		pgtype.UUID{Bytes: [16]byte{1}, Valid: true}, pgtype.UUID{}, "architecture"); err == nil {
		t.Fatal("query error must propagate")
	}
}

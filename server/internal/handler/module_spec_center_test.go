package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func decodeJSON[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var out T
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode json (%s): %v", w.Body.String(), err)
	}
	return out
}

// TestModuleSpecCenterLifecycle 端到端串起 07 §07 的核心闭环（真实 PG）：
// spec 发布 + 投影重建 + 并发/校验错误 → 模块级原型「无需求登记」（硬伤 3）→
// 解析缓存 → 后端唯一口径四态对账 + 覆盖率。
func TestModuleSpecCenterLifecycle(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()

	// 1) 建项目 + 模块
	w := httptest.NewRecorder()
	testHandler.CreateProject(w, newRequest("POST", "/api/projects?workspace_id="+testWorkspaceID,
		map[string]any{"title": "Module spec center project"}))
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateProject: %d %s", w.Code, w.Body.String())
	}
	project := decodeJSON[ProjectResponse](t, w)

	w = httptest.NewRecorder()
	req := newRequest("POST", "/api/projects/"+project.ID+"/modules", map[string]any{"name": "申报清单页"})
	req = withURLParam(req, "id", project.ID)
	testHandler.CreateProjectModule(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateProjectModule: %d %s", w.Code, w.Body.String())
	}
	module := decodeJSON[ProjectModuleResponse](t, w)

	t.Cleanup(func() {
		// 模块级原型行的 FK 是 SET NULL（非 CASCADE），先手删避免 owner CHECK 冲突。
		testPool.Exec(ctx, `DELETE FROM issue_prototype_version WHERE module_id = $1`, module.ID)
		testPool.Exec(ctx, `DELETE FROM project_module WHERE id = $1`, module.ID)
		testPool.Exec(ctx, `DELETE FROM project WHERE id = $1`, project.ID)
	})

	spec := map[string]any{"schema": "module_spec/v1", "features": []map[string]any{
		{"code": "FP-1", "title": "申报清单列表", "kind": "core", "priority": "P0"},
		{"code": "FP-2", "title": "新建申报", "kind": "core"},
		{"code": "FP-3", "title": "批量导出", "kind": "edge"},
	}}

	// 2) PublishModuleSpec → v1 + 投影重建 3 行
	publish := func(body map[string]any) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		r := newRequest("POST", "/api/projects/"+project.ID+"/modules/"+module.ID+"/spec/publish", body)
		r = withURLParams(r, "id", project.ID, "moduleId", module.ID)
		testHandler.PublishModuleSpec(rec, r)
		return rec
	}
	w = publish(map[string]any{"spec": spec})
	if w.Code != http.StatusOK {
		t.Fatalf("PublishModuleSpec: %d %s", w.Code, w.Body.String())
	}
	pubResp := decodeJSON[map[string]any](t, w)
	if v := pubResp["spec_version"].(float64); v != 1 {
		t.Errorf("spec_version = %v, want 1", v)
	}
	if fc := pubResp["feature_count"].(float64); fc != 3 {
		t.Errorf("feature_count = %v, want 3", fc)
	}
	var projRows int
	if err := testPool.QueryRow(ctx, `SELECT count(*) FROM project_module_feature WHERE module_id = $1`, module.ID).Scan(&projRows); err != nil {
		t.Fatalf("projection count: %v", err)
	}
	if projRows != 3 {
		t.Errorf("project_module_feature rows = %d, want 3", projRows)
	}

	// 3) expected_version 过期 → 409 spec_version_conflict
	w = publish(map[string]any{"spec": spec, "expected_version": 99})
	if w.Code != http.StatusConflict {
		t.Fatalf("stale expected_version: want 409, got %d %s", w.Code, w.Body.String())
	}

	// 4) 功能点 code 重复 → 422 feature_code_duplicated
	dupSpec := map[string]any{"schema": "module_spec/v1", "features": []map[string]any{
		{"code": "FP-1", "title": "a"}, {"code": "FP-1", "title": "b"},
	}}
	w = publish(map[string]any{"spec": dupSpec})
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("dup code: want 422, got %d %s", w.Code, w.Body.String())
	}

	// 5) 无原型 → 对账全 missing
	getReconcile := func(query string) map[string]any {
		rec := httptest.NewRecorder()
		r := newRequest("GET", "/api/projects/"+project.ID+"/modules/"+module.ID+"/prototype-reconcile"+query, nil)
		r = withURLParams(r, "id", project.ID, "moduleId", module.ID)
		testHandler.GetPrototypeReconcile(rec, r)
		if rec.Code != http.StatusOK {
			t.Fatalf("GetPrototypeReconcile: %d %s", rec.Code, rec.Body.String())
		}
		return decodeJSON[map[string]any](t, rec)
	}
	covOf := func(resp map[string]any) map[string]any {
		return resp["coverage"].(map[string]any)
	}
	cov := covOf(getReconcile(""))
	if cov["total"].(float64) != 3 || cov["missing"].(float64) != 3 || cov["rate"].(float64) != 0 {
		t.Fatalf("empty-proto coverage = %v, want total3 missing3 rate0", cov)
	}

	// 6) 硬伤 3：登记一版「无 issue」的模块级原型（confirmed + 设权威）
	w = httptest.NewRecorder()
	r := newRequest("POST", "/api/projects/"+project.ID+"/modules/"+module.ID+"/prototype-versions",
		map[string]any{"version": 1, "html_path": "prototypes/申报清单页/v1.html", "prompt": "x", "status": "confirmed", "set_canonical": true})
	r = withURLParams(r, "id", project.ID, "moduleId", module.ID)
	testHandler.RegisterModulePrototypeVersion(w, r)
	if w.Code != http.StatusCreated {
		t.Fatalf("RegisterModulePrototypeVersion (no issue): %d %s", w.Code, w.Body.String())
	}

	// 列表可见 + canonical=1
	w = httptest.NewRecorder()
	r = newRequest("GET", "/api/projects/"+project.ID+"/modules/"+module.ID+"/prototype-versions", nil)
	r = withURLParams(r, "id", project.ID, "moduleId", module.ID)
	testHandler.ListModulePrototypeVersions(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("ListModulePrototypeVersions: %d %s", w.Code, w.Body.String())
	}
	list := decodeJSON[map[string]any](t, w)
	if list["total"].(float64) != 1 {
		t.Errorf("versions total = %v, want 1", list["total"])
	}
	if list["canonical_prototype_version"].(float64) != 1 {
		t.Errorf("canonical = %v, want 1", list["canonical_prototype_version"])
	}

	// 7) 存解析缓存（三功能点均命中且标题一致）→ 对账全 covered，rate 1.0
	w = httptest.NewRecorder()
	r = newRequest("POST", "/api/projects/"+project.ID+"/modules/"+module.ID+"/prototype-versions/1/parse",
		map[string]any{"anchors": map[string]any{
			"FP-1": map[string]any{"count": 1, "title": "申报清单列表"},
			"FP-2": map[string]any{"count": 2, "title": "新建申报"},
			"FP-3": map[string]any{"count": 1, "title": "批量导出"},
		}})
	r = withURLParams(r, "id", project.ID, "moduleId", module.ID, "version", "1")
	testHandler.ParseModulePrototype(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("ParseModulePrototype: %d %s", w.Code, w.Body.String())
	}
	cov = covOf(getReconcile("?version=1"))
	if cov["covered"].(float64) != 3 || cov["rate"].(float64) != 1.0 {
		t.Fatalf("full-proto coverage = %v, want covered3 rate1", cov)
	}

	// 8) 重复版本登记 → 409 prototype_version_exists
	w = httptest.NewRecorder()
	r = newRequest("POST", "/api/projects/"+project.ID+"/modules/"+module.ID+"/prototype-versions",
		map[string]any{"version": 1, "html_path": "dup.html", "status": "pending"})
	r = withURLParams(r, "id", project.ID, "moduleId", module.ID)
	testHandler.RegisterModulePrototypeVersion(w, r)
	if w.Code != http.StatusConflict {
		t.Fatalf("duplicate version: want 409, got %d %s", w.Code, w.Body.String())
	}
}

// TestModulePrototypePlanApply 验证 07 §2.5 D-D 发布两段式（M-07，真实 PG）：
// Agent 只能建 draft 计划（不移动权威）→ 人 apply 才在同一事务内移动 canonical /
// bump spec / 重建投影；重复 apply 同一 planId → 409 幂等；候选未登记 → 404；
// 候选 pending → 409 canonical_pending_not_allowed。
func TestModulePrototypePlanApply(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()

	w := httptest.NewRecorder()
	testHandler.CreateProject(w, newRequest("POST", "/api/projects?workspace_id="+testWorkspaceID,
		map[string]any{"title": "Plan apply project"}))
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateProject: %d %s", w.Code, w.Body.String())
	}
	project := decodeJSON[ProjectResponse](t, w)

	w = httptest.NewRecorder()
	req := newRequest("POST", "/api/projects/"+project.ID+"/modules", map[string]any{"name": "发布两段页"})
	req = withURLParam(req, "id", project.ID)
	testHandler.CreateProjectModule(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateProjectModule: %d %s", w.Code, w.Body.String())
	}
	module := decodeJSON[ProjectModuleResponse](t, w)

	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM module_prototype_plan WHERE module_id = $1`, module.ID)
		testPool.Exec(ctx, `DELETE FROM issue_prototype_version WHERE module_id = $1`, module.ID)
		testPool.Exec(ctx, `DELETE FROM project_module WHERE id = $1`, module.ID)
		testPool.Exec(ctx, `DELETE FROM project WHERE id = $1`, project.ID)
	})

	baseSpec := map[string]any{"schema": "module_spec/v1", "features": []map[string]any{
		{"code": "FP-1", "title": "列表", "kind": "core"},
		{"code": "FP-2", "title": "新建", "kind": "core"},
	}}
	publish := func(body map[string]any) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		r := newRequest("POST", "/api/projects/"+project.ID+"/modules/"+module.ID+"/spec/publish", body)
		r = withURLParams(r, "id", project.ID, "moduleId", module.ID)
		testHandler.PublishModuleSpec(rec, r)
		return rec
	}
	if rec := publish(map[string]any{"spec": baseSpec}); rec.Code != http.StatusOK {
		t.Fatalf("publish base: %d %s", rec.Code, rec.Body.String())
	}

	// 登记候选 v2（confirmed），但不设权威 —— 权威移动是 apply 的专属职责。
	w = httptest.NewRecorder()
	req = newRequest("POST", "/api/projects/"+project.ID+"/modules/"+module.ID+"/prototype-versions",
		map[string]any{"version": 2, "html_path": "v2.html", "status": "confirmed"})
	req = withURLParams(req, "id", project.ID, "moduleId", module.ID)
	testHandler.RegisterModulePrototypeVersion(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("register candidate v2: %d %s", w.Code, w.Body.String())
	}

	// 建计划（带新 spec 3 功能点）→ draft；此刻 canonical 仍为 NULL（未被计划移动）。
	newSpec := map[string]any{"schema": "module_spec/v1", "features": []map[string]any{
		{"code": "FP-1", "title": "列表", "kind": "core"},
		{"code": "FP-2", "title": "新建", "kind": "core"},
		{"code": "FP-3", "title": "导出", "kind": "edge"},
	}}
	w = httptest.NewRecorder()
	req = newRequest("POST", "/api/projects/"+project.ID+"/modules/"+module.ID+"/prototype-plans",
		map[string]any{"candidate_version": 2, "new_spec": newSpec})
	req = withURLParams(req, "id", project.ID, "moduleId", module.ID)
	testHandler.CreatePrototypePlan(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreatePrototypePlan: %d %s", w.Code, w.Body.String())
	}
	plan := decodeJSON[map[string]any](t, w)
	planID := plan["id"].(string)
	if plan["status"].(string) != "draft" {
		t.Errorf("plan status = %v, want draft", plan["status"])
	}
	var canonBefore *int
	if err := testPool.QueryRow(ctx, `SELECT canonical_prototype_version FROM project_module WHERE id = $1`, module.ID).Scan(&canonBefore); err != nil {
		t.Fatalf("read canonical: %v", err)
	}
	if canonBefore != nil {
		t.Errorf("canonical moved by CREATE (plan step): got %v, want NULL", *canonBefore)
	}

	applyPlan := func() *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		r := newRequest("POST", "/api/projects/"+project.ID+"/modules/"+module.ID+"/prototype-plans/"+planID+"/apply", nil)
		r = withURLParams(r, "id", project.ID, "moduleId", module.ID, "planId", planID)
		testHandler.ApplyPrototypePlan(rec, r)
		return rec
	}
	// 人 apply → canonical→2、spec_version→2、投影→3、计划→applied。
	w = applyPlan()
	if w.Code != http.StatusOK {
		t.Fatalf("ApplyPrototypePlan: %d %s", w.Code, w.Body.String())
	}
	ap := decodeJSON[map[string]any](t, w)
	if ap["canonical_prototype_version"].(float64) != 2 {
		t.Errorf("applied canonical = %v, want 2", ap["canonical_prototype_version"])
	}
	if ap["spec_version"].(float64) != 2 || ap["feature_count"].(float64) != 3 {
		t.Errorf("applied spec_version/count = %v/%v, want 2/3", ap["spec_version"], ap["feature_count"])
	}
	var canonAfter *int
	var specVer int
	if err := testPool.QueryRow(ctx, `SELECT canonical_prototype_version, spec_version FROM project_module WHERE id = $1`, module.ID).Scan(&canonAfter, &specVer); err != nil {
		t.Fatalf("read after apply: %v", err)
	}
	if canonAfter == nil || *canonAfter != 2 || specVer != 2 {
		t.Errorf("post-apply canonical=%v spec_ver=%d, want 2/2", canonAfter, specVer)
	}
	var projRows int
	if err := testPool.QueryRow(ctx, `SELECT count(*) FROM project_module_feature WHERE module_id = $1`, module.ID).Scan(&projRows); err != nil {
		t.Fatalf("projection count: %v", err)
	}
	if projRows != 3 {
		t.Errorf("projection rows = %d, want 3", projRows)
	}

	// 重复 apply 同一 planId → 409 plan_already_applied（幂等，只生效一次）。
	w = applyPlan()
	if w.Code != http.StatusConflict {
		t.Fatalf("repeat apply: want 409, got %d %s", w.Code, w.Body.String())
	}
	if code := decodeJSON[map[string]any](t, w)["code"]; code != "plan_already_applied" {
		t.Errorf("repeat apply code = %v, want plan_already_applied", code)
	}

	// 候选未登记 → 404 prototype_version_not_found。
	w = httptest.NewRecorder()
	req = newRequest("POST", "/api/projects/"+project.ID+"/modules/"+module.ID+"/prototype-plans",
		map[string]any{"candidate_version": 99})
	req = withURLParams(req, "id", project.ID, "moduleId", module.ID)
	testHandler.CreatePrototypePlan(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("plan for unregistered candidate: want 404, got %d %s", w.Code, w.Body.String())
	}

	// 候选 pending → 409 canonical_pending_not_allowed（权威只允许指向 confirmed）。
	w = httptest.NewRecorder()
	req = newRequest("POST", "/api/projects/"+project.ID+"/modules/"+module.ID+"/prototype-versions",
		map[string]any{"version": 3, "html_path": "v3.html", "status": "pending"})
	req = withURLParams(req, "id", project.ID, "moduleId", module.ID)
	testHandler.RegisterModulePrototypeVersion(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("register v3 pending: %d %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	req = newRequest("POST", "/api/projects/"+project.ID+"/modules/"+module.ID+"/prototype-plans",
		map[string]any{"candidate_version": 3})
	req = withURLParams(req, "id", project.ID, "moduleId", module.ID)
	testHandler.CreatePrototypePlan(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("plan for pending candidate: want 409, got %d %s", w.Code, w.Body.String())
	}
}

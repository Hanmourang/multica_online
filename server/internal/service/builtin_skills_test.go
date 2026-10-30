package service

import (
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/util"
	"gopkg.in/yaml.v3"
)

// Built-in skills are the platform's standard "template" skills. These evals
// pin the template every skill must follow and — crucially — couple each
// skill's documented contract to the real backend behavior it describes, so a
// drift in the source-of-truth (e.g. the mention regex) breaks CI instead of
// silently turning the skill into a lie agents act on.
//
// The evals live in a _test.go file on purpose: anything *inside* a skill
// directory is walked into AgentSkillData.Files and shipped to agent machines
// (see loadBuiltinSkill). Tests must stay out of that payload.

const (
	// maxSkillBodyLines is Anthropic's L2 budget for a SKILL.md body
	// (~5k tokens). Past this, content belongs in one-level-deep supporting
	// files, not the always-loaded body.
	maxSkillBodyLines = 500
	// maxDescriptionChars is the frontmatter description cap — it is the only
	// thing an agent sees when deciding whether to load the skill, and every
	// runtime CLI pays for it in the always-loaded skill listing. A description
	// earns its characters two ways only: trigger wording that matches how the
	// task actually arrives, and reverse boundaries that prevent mis-routing.
	// A "Covers A, B, C..." content inventory does neither — the agent reads the
	// body once it opens the skill. The cap is deliberately tight (the longest
	// built-in sits at 222) so that inventory prose cannot creep back in.
	maxDescriptionChars = 300
)

// TestBuiltinSkillsConformToTemplate enforces the standard-template invariants
// on every built-in skill, current and future. A new skill that violates the
// shape fails here without anyone having to remember the rules.
func TestBuiltinSkillsConformToTemplate(t *testing.T) {
	skills := loadBuiltinSkills()
	if len(skills) == 0 {
		t.Fatal("no built-in skills loaded; embed or layout is broken")
	}

	for _, skill := range skills {
		t.Run(skill.Name, func(t *testing.T) {
			// The multica- prefix keeps the on-disk slug from colliding with a
			// user-authored workspace skill.
			if !strings.HasPrefix(skill.Name, "multica-") {
				t.Errorf("skill name %q must carry the multica- prefix", skill.Name)
			}

			fm, body, ok := splitFrontmatter(skill.Content)
			if !ok {
				t.Fatalf("SKILL.md must lead with a --- frontmatter block")
			}
			if strings.TrimSpace(fm["name"]) == "" {
				t.Errorf("frontmatter is missing a non-empty name")
			}
			if strings.TrimSpace(skill.Description) == "" {
				t.Errorf("description was not copied out of frontmatter")
			}
			desc := strings.TrimSpace(fm["description"])
			if desc == "" {
				t.Errorf("frontmatter is missing a description (the only thing an agent sees when deciding to load the skill)")
			}
			if len(desc) > maxDescriptionChars {
				t.Errorf("description is %d chars, over the %d cap", len(desc), maxDescriptionChars)
			}
			if n := strings.Count(body, "\n") + 1; n > maxSkillBodyLines {
				t.Errorf("SKILL.md body is %d lines, over the %d-line L2 budget; move detail into one-level-deep supporting files", n, maxSkillBodyLines)
			}

			// Evals must never ride along to agent machines as supporting files.
			for _, f := range skill.Files {
				lower := strings.ToLower(f.Path)
				if strings.Contains(lower, "eval") || strings.HasSuffix(lower, "_test.go") || strings.HasSuffix(lower, "_test.md") {
					t.Errorf("supporting file %q looks like an eval/test; evals belong in _test.go, not the shipped skill payload", f.Path)
				}
			}
		})
	}
}

// TestBuiltinSkillsFrontmatterIsStrictYAML is the regression guard for MUL-3100
// / GitHub #3851: a built-in SKILL.md whose frontmatter is not valid YAML 1.2
// (the canonical break is an unquoted `: ` inside the description) is silently
// dropped by strict runtimes like Codex, so the agent runs without that
// platform-contract skill.
//
// This check is deliberately separate from TestBuiltinSkillsConformToTemplate:
// that test reads the frontmatter through splitFrontmatter, a naive line parser
// that splits on the first ':' and never runs a YAML parse — so it passes even
// on the broken files. Only a real yaml.Unmarshal reproduces what Codex does,
// which is exactly what is needed to catch this class of bug before it ships.
func TestBuiltinSkillsFrontmatterIsStrictYAML(t *testing.T) {
	skills := loadBuiltinSkills()
	if len(skills) == 0 {
		t.Fatal("no built-in skills loaded; embed or layout is broken")
	}

	for _, skill := range skills {
		t.Run(skill.Name, func(t *testing.T) {
			content := skill.Content
			if !strings.HasPrefix(content, "---\n") {
				t.Fatalf("SKILL.md must lead with a --- frontmatter block")
			}
			rest := content[len("---\n"):]
			end := strings.Index(rest, "\n---")
			if end < 0 {
				t.Fatalf("frontmatter has no closing --- delimiter")
			}

			var fm map[string]any
			if err := yaml.Unmarshal([]byte(rest[:end]), &fm); err != nil {
				t.Fatalf("frontmatter is not valid YAML — a strict runtime (e.g. Codex) "+
					"will drop this skill on load; quote values containing ': ': %v", err)
			}

			if name, ok := fm["name"].(string); !ok || strings.TrimSpace(name) == "" {
				t.Errorf("frontmatter name must parse as a non-empty string, got %#v", fm["name"])
			}
			if desc, ok := fm["description"].(string); !ok || strings.TrimSpace(desc) == "" {
				t.Errorf("frontmatter description must parse as a non-empty string, got %#v", fm["description"])
			}
		})
	}
}

// TestMentioningSkillFollowsContractFrontmatter locks the reference template:
// the mentioning skill is a context-triggered platform-contract skill, so it
// must declare user-invocable:false and fence itself to the multica CLI. New
// contract skills should copy this shape.
func TestMentioningSkillFollowsContractFrontmatter(t *testing.T) {
	skill, ok := findSkill(t, "multica-mentioning")
	if !ok {
		return
	}
	fm, _, _ := splitFrontmatter(skill.Content)

	if got := strings.TrimSpace(fm["user-invocable"]); got != "false" {
		t.Errorf("user-invocable = %q, want false (a platform-contract skill triggers from context, not a slash command)", got)
	}
	if got := strings.TrimSpace(fm["allowed-tools"]); got != "Bash(multica *)" {
		t.Errorf("allowed-tools = %q, want Bash(multica *) (fence the skill to the CLI it teaches)", got)
	}
}

// TestMentioningSkillTeachesTheParserContract is the eval that gives the skill
// its value: it proves the skill teaches exactly what util.ParseMentions
// enforces. The skill's "Incorrect" examples must parse to nothing (the
// @gpt-boy class of bug: a name where a UUID belongs fails silently), and its
// "Correct" example must parse. If mention.go:16 drifts, this breaks and the
// skill's claims must be re-checked.
func TestMentioningSkillTeachesTheParserContract(t *testing.T) {
	const uuid = "7f3a1b2c-0000-4000-8000-000000000abc"

	cases := []struct {
		name    string
		content string
		want    []util.Mention
	}{
		{
			// Skill: "Writing [@Alice](mention://member/Alice) does NOTHING."
			// 'l'/'i' are not hex, so the id fails to parse — link is dead.
			name:    "name where a uuid belongs is silently dead",
			content: "[@Alice](mention://member/Alice) please review",
			want:    nil,
		},
		{
			// Skill: a bare @name is plain text, nobody is notified.
			name:    "bare @name is plain text",
			content: "@alice please review",
			want:    nil,
		},
		{
			// Skill Step 2: type and id source matched → fires.
			name:    "real uuid with matching type fires",
			content: "[@Alice](mention://member/" + uuid + ") please review",
			want:    []util.Mention{{Type: "member", ID: uuid}},
		},
		{
			// Skill: @all uses the literal `all`, never a UUID.
			name:    "all uses the literal all",
			content: "[@all](mention://all/all) heads up",
			want:    []util.Mention{{Type: "all", ID: "all"}},
		},
		{
			// Skill: "Using the wrong type for an id points at the wrong
			// entity." The link still parses — it just resolves wrong — which
			// is exactly why the skill stresses matching type to id source.
			name:    "wrong type still parses (points at wrong entity)",
			content: "[@Bot](mention://member/" + uuid + ")",
			want:    []util.Mention{{Type: "member", ID: uuid}},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := util.ParseMentions(tc.content)
			if len(got) != len(tc.want) {
				t.Fatalf("ParseMentions(%q) = %+v, want %+v", tc.content, got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Errorf("mention[%d] = %+v, want %+v", i, got[i], tc.want[i])
				}
			}
		})
	}
}

func TestWorkingOnIssuesSkillCoversIssueLoopContracts(t *testing.T) {
	skill, ok := findSkill(t, "multica-working-on-issues")
	if !ok {
		return
	}
	fm, body, _ := splitFrontmatter(skill.Content)

	if got := strings.TrimSpace(fm["user-invocable"]); got != "false" {
		t.Errorf("user-invocable = %q, want false (issue workflow guidance triggers from context)", got)
	}
	if got := strings.TrimSpace(fm["allowed-tools"]); !strings.Contains(got, "Bash(multica *)") {
		t.Errorf("allowed-tools = %q, want access to the Multica CLI", got)
	}

	// Contract anchors only — exact file:line citations live in the skill's
	// references/source-map.md, not here, so a downstream main merge that
	// shifts a line cannot rot this test into pinning a stale lie.
	mustContain := []string{
		"multica issue pull-requests <issue-id> --output json",
		"Default for code-changing issue work",
		"open or update a PR before posting the final Multica issue comment",
		"This is a default, not",
		"Use a routable issue key in the PR title, body, or branch",
		"include the PR URL when a PR exists",
		"Closes MUL-2759",
		"--status backlog",
		// The only sanctioned pr_url reference is the negative compatibility
		// warning about pre-existing data — not a write recommendation
		// (MUL-5442 owner ruling: no curated key vocabulary).
		"`pr_url` metadata (which can be",
		"references/working-on-issues-source-map.md",
		// MUL-5442: the brief's Sub-issue Creation section is now a one-line
		// map pointing here. These anchors are the demoted playbook — if they
		// leave the skill, the brief pointer dangles.
		"`todo` starts work now, `backlog` parks it",
		"`--stage <N>`",
		"when a whole stage finishes",
		"multica issue status <child-id> todo",
		// MUL-5442: the brief's Issue Metadata section defers the full
		// write discipline here. Every relocated ban is anchored
		// individually — both defining categories AND each example —
		// so no single item or category boundary can be dropped while
		// the brief still points at this skill (round-3 review).
		"Never store secrets, tokens, or API keys",
		"Not metadata: logs or summaries",
		"bookkeeping such as timestamps",
		"attempt counts, or agent IDs",
		"other single-run details",
		"files touched and investigation notes",
		"belong in the result comment",
		// Owner ruling: metadata is deliberately free-form custom state;
		// the platform curates no key vocabulary.
		"the platform curates no vocabulary",
		// #7768: nothing about concurrent runs is pushed into the prompt any
		// more (MUL-6984), so the skill has to carry the pull path itself.
		// All three anchors are load-bearing — the command is the remedy, the
		// cap disclosure is what stops a truncated answer from reading as an
		// empty one, and the advisory line is a negative safety boundary: an
		// agent that reads these as a lock will skip the coordination they
		// exist to prompt.
		"multica issue runs <issue-id> --siblings --output json",
		"capped at 20",
		"Nothing here reserves an issue or serialises anything",
	}
	for _, want := range mustContain {
		if !strings.Contains(body, want) {
			t.Errorf("working-on-issues skill missing %q", want)
		}
	}

	mustNotContain := []string{
		// A curated key list is the "recommended fields" concept the owner
		// ruled out on MUL-5442 — it must not creep back into the skill
		// that loads exactly when an agent is about to write metadata.
		"High-signal keys",
		"reuse these names so queries stay consistent",
		"scratchpad for run state",
		"(`pr_url`, `waiting_on`",
		"Start from the trigger, not from memory",
		"multica issue get <issue-id> --output json",
		"multica issue metadata list <issue-id> --output json",
		"multica issue comment list <issue-id> --thread <trigger-comment-id>",
		"multica issue comment add <issue-id> --parent <trigger-comment-id>",
	}
	for _, forbidden := range mustNotContain {
		if strings.Contains(body, forbidden) {
			t.Errorf("working-on-issues skill duplicates runtime prompt contract %q", forbidden)
		}
	}

	if !skillHasFile(skill, "references/working-on-issues-source-map.md") {
		t.Errorf("working-on-issues skill missing supporting file references/working-on-issues-source-map.md")
	}
}

func TestSkillImportingSkillCoversWorkspaceImportContracts(t *testing.T) {
	skill, ok := findSkill(t, "multica-skill-importing")
	if !ok {
		return
	}
	fm, body, _ := splitFrontmatter(skill.Content)

	if got := strings.TrimSpace(fm["user-invocable"]); got != "false" {
		t.Errorf("user-invocable = %q, want false (skill import guidance triggers from context)", got)
	}
	if got := strings.TrimSpace(fm["allowed-tools"]); !strings.Contains(got, "Bash(multica *)") {
		t.Errorf("allowed-tools = %q, want access to the Multica CLI", got)
	}

	mustContain := []string{
		"multica skill import --url <url> --output json",
		"/api/skills/import",
		"clawhub.ai",
		"skills.sh",
		"github.com",
		"config.origin",
		"--on-conflict fail",
		"--on-conflict overwrite",
		"--on-conflict rename",
		"--on-conflict skip",
		"status",
		"conflict",
		"skipped",
		"409",
		"existing_skill",
		"id",
		"name",
		"legacy",
		"multica skill list --output json",
		"npx skills add",
		"multica agent skills add <agent-id> --skill-ids <skill-id> --output json",
		"multica agent skills list <agent-id> --output json",
		"replace-all",
		"`set` is the replacement path",
		"references/skill-importing-source-map.md",
	}
	for _, want := range mustContain {
		if !strings.Contains(body, want) {
			t.Errorf("skill-importing skill missing %q", want)
		}
	}

	mustNotContain := []string{
		"multica agent skills set <agent-id> --skill-ids <skill-id>",
		"merge the new skill id with the existing ids",
	}
	for _, forbidden := range mustNotContain {
		if strings.Contains(body, forbidden) {
			t.Errorf("skill-importing skill should not teach stale or destructive binding command %q", forbidden)
		}
	}

	if !skillHasFile(skill, "references/skill-importing-source-map.md") {
		t.Errorf("skill-importing skill missing supporting file references/skill-importing-source-map.md")
	}
}

func TestCreatingAgentsSkillCoversAgentCreationContracts(t *testing.T) {
	skill, ok := findSkill(t, "multica-creating-agents")
	if !ok {
		return
	}
	fm, body, _ := splitFrontmatter(skill.Content)

	if got := strings.TrimSpace(fm["user-invocable"]); got != "false" {
		t.Errorf("user-invocable = %q, want false (agent creation guidance triggers from context)", got)
	}
	if got := strings.TrimSpace(fm["allowed-tools"]); !strings.Contains(got, "Bash(multica *)") {
		t.Errorf("allowed-tools = %q, want access to the Multica CLI", got)
	}

	mustContain := []string{
		"not a parameter manual",
		"`description` is a catalog summary",
		"`instructions` is the runtime behavior contract",
		"`conversation_starters`",
		"`avatar_url` → a random `emoji:<glyph>`",
		"multica agent create --name <name> --runtime-id <runtime-id>",
		"`model` is a first-class persisted column",
		"custom_env",
		"Never put credentials or other secrets in `custom_args`",
		"--custom-env-stdin",
		"--custom-env-file",
		"multica agent skills add <agent-id> --skill-ids <skill-id> --output json",
		"multica agent skills list <agent-id> --output json",
		"multica agent get <agent-id> --output json",
		"255",
		"references/creating-agents-source-map.md",
	}
	for _, want := range mustContain {
		if !strings.Contains(body, want) {
			t.Errorf("creating-agents skill missing %q", want)
		}
	}

	mustNotContain := []string{
		"--from-template",
		"/api/agent-templates",
		"template_slug",
		"curated template",
		"copy this parameter list",
		// De-coaching: this skill states source-backed contracts, it does not
		// teach a generic how-to methodology.
		"Define the job first",
		"Run a low-risk task",
		"Decision flow",
	}
	for _, forbidden := range mustNotContain {
		if strings.Contains(body, forbidden) {
			t.Errorf("creating-agents skill should not teach immature template content or generic how-to coaching %q", forbidden)
		}
	}

	if !skillHasFile(skill, "references/creating-agents-source-map.md") {
		t.Errorf("creating-agents skill missing supporting file references/creating-agents-source-map.md")
	}
}

func TestSquadsSkillCoversLeaderRoutingContract(t *testing.T) {
	skill, ok := findSkill(t, "multica-squads")
	if !ok {
		return
	}
	fm, body, _ := splitFrontmatter(skill.Content)

	if got := strings.TrimSpace(fm["user-invocable"]); got != "false" {
		t.Errorf("user-invocable = %q, want false (squad guidance triggers from context)", got)
	}
	if got := strings.TrimSpace(fm["allowed-tools"]); !strings.Contains(got, "Bash(multica *)") {
		t.Errorf("allowed-tools = %q, want access to the Multica CLI", got)
	}

	mustContain := []string{
		"A squad is not an agent",
		"squad's `leader_id` agent",
		"squad members are not automatically fanned out",
		"multica squad member set-role",
		"mention://squad/<squad-id>",
		"recording squad activity",
		"references/squad-source-map.md",
		// The debugging quick-start must stay a bounded two-step read
		// (MUL-5442): a roots-only scan alone never returns reply bodies,
		// where mention triggers and failure reasons usually live — and it
		// must not regress to a --recent bulk pull either.
		"--roots-only --summary",
		"--thread <thread-id> --tail 30",
		"scan the roots first, then open the threads",
	}
	for _, want := range mustContain {
		if !strings.Contains(body, want) {
			t.Errorf("squads skill missing %q", want)
		}
	}

	// MUL-5696: no unbounded comment pull anywhere in the skill. #6347 fixed
	// the quick start's `--recent 10` but missed a second unbounded
	// `issue comment list` in the CLI section; both shapes contradict the
	// brief's "two bounded reads, never one bulk pull" doctrine.
	for _, banned := range []string{
		"multica issue comment list <issue-id> --output json",
		"--recent 10",
	} {
		if strings.Contains(body, banned) {
			t.Errorf("squads skill carries the unbounded comment read %q (MUL-5696)", banned)
		}
	}

	if !skillHasFile(skill, "references/squad-source-map.md") {
		t.Errorf("squads skill missing supporting file references/squad-source-map.md")
	}
}

func TestAutopilotsSkillCoversDispatchAndSideEffects(t *testing.T) {
	skill, ok := findSkill(t, "multica-autopilots")
	if !ok {
		return
	}
	fm, body, _ := splitFrontmatter(skill.Content)

	if got := strings.TrimSpace(fm["user-invocable"]); got != "false" {
		t.Errorf("user-invocable = %q, want false", got)
	}
	if got := strings.TrimSpace(fm["allowed-tools"]); !strings.Contains(got, "Bash(multica *)") {
		t.Errorf("allowed-tools = %q, want access to the Multica CLI", got)
	}

	mustContain := []string{
		"An autopilot is not an agent",
		"create_issue",
		"run_only",
		"multica autopilot trigger-add <autopilot-id> --kind schedule",
		"multica autopilot trigger <autopilot-id> --output json",
		"Do not run `trigger`",
		"webhook tokens",
		"{{date}}",
		"squad's leader agent",
		"references/autopilots-source-map.md",
	}
	for _, want := range mustContain {
		if !strings.Contains(body, want) {
			t.Errorf("autopilots skill missing %q", want)
		}
	}
	if !skillHasFile(skill, "references/autopilots-source-map.md") {
		t.Errorf("autopilots skill missing supporting file references/autopilots-source-map.md")
	}
}

func TestRuntimesAndReposSkillCoversClaimAndCheckoutChain(t *testing.T) {
	skill, ok := findSkill(t, "multica-runtimes-and-repos")
	if !ok {
		return
	}
	fm, body, _ := splitFrontmatter(skill.Content)

	if got := strings.TrimSpace(fm["user-invocable"]); got != "false" {
		t.Errorf("user-invocable = %q, want false", got)
	}
	if got := strings.TrimSpace(fm["allowed-tools"]); !strings.Contains(got, "Bash(multica *)") {
		t.Errorf("allowed-tools = %q, want access to the Multica CLI", got)
	}

	mustContain := []string{
		"agent_task_queue",
		"daemon polls/claims the task",
		"multica runtime list --output json",
		"multica repo checkout <url>",
		"MULTICA_DAEMON_PORT",
		"resource_ref.ref",
		"github_repo",
		"local_directory",
		"Runtime and repo commands affect active agent execution",
		"references/runtimes-and-repos-source-map.md",
		// An agent reads this to know whether its checkout can be committed to.
		// Codex on Linux and Windows gets task-local Git metadata; every other
		// runtime gets a linked worktree (multica-ai/multica#2925, #6449).
		"Linux and Windows Codex",
		"task-local Git metadata",
	}
	for _, want := range mustContain {
		if !strings.Contains(body, want) {
			t.Errorf("runtimes-and-repos skill missing %q", want)
		}
	}
	if !skillHasFile(skill, "references/runtimes-and-repos-source-map.md") {
		t.Errorf("runtimes-and-repos skill missing supporting file references/runtimes-and-repos-source-map.md")
	}
}

func TestProjectsAndResourcesSkillCoversDurableContext(t *testing.T) {
	skill, ok := findSkill(t, "multica-projects-and-resources")
	if !ok {
		return
	}
	fm, body, _ := splitFrontmatter(skill.Content)

	if got := strings.TrimSpace(fm["user-invocable"]); got != "false" {
		t.Errorf("user-invocable = %q, want false", got)
	}
	if got := strings.TrimSpace(fm["allowed-tools"]); !strings.Contains(got, "Bash(multica *)") {
		t.Errorf("allowed-tools = %q, want access to the Multica CLI", got)
	}

	mustContain := []string{
		"Projects are durable context containers",
		".multica/project/resources.json",
		"multica project resource list <project-id> --output json",
		"multica project resource add <project-id> --type github_repo --url <github-url> --output json",
		"multica project resource add <project-id> --type github_repo --url <github-url> --ref <branch-or-sha> --output json",
		"multica project resource add <project-id> --type local_directory",
		"Project resources are durable and affect future tasks",
		"github_repo.resource_ref.url",
		"resource_ref.ref",
		"references/projects-and-resources-source-map.md",
	}
	for _, want := range mustContain {
		if !strings.Contains(body, want) {
			t.Errorf("projects-and-resources skill missing %q", want)
		}
	}
	if !skillHasFile(skill, "references/projects-and-resources-source-map.md") {
		t.Errorf("projects-and-resources skill missing supporting file references/projects-and-resources-source-map.md")
	}
}

func TestFeatureModulesSkillCoversPrototypeChain(t *testing.T) {
	skill, ok := findSkill(t, "multica-feature-modules")
	if !ok {
		return
	}
	fm, body, _ := splitFrontmatter(skill.Content)

	if got := strings.TrimSpace(fm["user-invocable"]); got != "false" {
		t.Errorf("user-invocable = %q, want false", got)
	}
	if got := strings.TrimSpace(fm["allowed-tools"]); !strings.Contains(got, "Bash(multica *)") {
		t.Errorf("allowed-tools = %q, want access to the Multica CLI", got)
	}

	mustContain := []string{
		// 六类对象都要有可写通路：漏一类，agent 就会退回猜端点。
		"multica module requirement add",
		"multica module spec feature add",
		"multica module spec feature update",
		"multica module spec feature remove",
		"multica module brief patch",
		"multica module prototype register",
		"multica module prototype update",
		"multica module prototype confirm",
		"multica module prototype delete",
		"multica module prototype parse",
		"multica module release publish",
		"multica module release rollback",
		// 版本对比总结是这一轮的核心诉求，两条命令都不能掉。
		"multica module prototype diff",
		"multica module brief diff",
		"multica module brief versions",
		// 版本有两种归属，模块级维护面只能改模块自有版本。
		"module-owned",
		"requirement-owned",
		// 基础读取面与 html_path 陷阱。
		"multica module list --project <project-id> --output json",
		"multica module get <module> --output json",
		"multica module prototype list <module> --output json",
		"multica module prototype read <module>",
		"multica module prototype read <module> --version 2",
		// html_path 是仓库相对路径，拼接/查找会导致读不到文件。
		"repository-relative",
		"change_logs/...",
		// 被 flag 门控的模块级端点必须明确劝退。
		"module_spec_center",
		// 与 project-tabs 技能的分工。
		"multica-project-tabs",
	}
	for _, want := range mustContain {
		if !strings.Contains(body, want) {
			t.Errorf("feature-modules skill missing %q", want)
		}
	}

	// 旧口径：模块不拥有原型、登记只能走 MCP。这两句会把 agent 劝退到不存在的路径上。
	mustNotContain := []string{
		"MCP only",
		"owns no prototype HTML of its own",
		"module → requirements → prototype versions → file",
	}
	for _, unwanted := range mustNotContain {
		if strings.Contains(body, unwanted) {
			t.Errorf("feature-modules skill still says %q", unwanted)
		}
	}
}

func TestProjectTabsSkillCoversTabMap(t *testing.T) {
	skill, ok := findSkill(t, "multica-project-tabs")
	if !ok {
		return
	}
	fm, body, _ := splitFrontmatter(skill.Content)

	if got := strings.TrimSpace(fm["user-invocable"]); got != "false" {
		t.Errorf("user-invocable = %q, want false", got)
	}
	if got := strings.TrimSpace(fm["allowed-tools"]); !strings.Contains(got, "Bash(multica *)") {
		t.Errorf("allowed-tools = %q, want access to the Multica CLI", got)
	}

	mustContain := []string{
		"multica project tab list <project>",
		"multica project tab get <project> <tab>",
		"--all-tabs",
		// 这 11 个 key 是前端的 PROJECT_VIEWS 契约，任何一个掉出表格，
		// agent 就会退回猜端点。
		"| `archive` |",
		"| `assets` |",
		"| `features` |",
		"| `data-model` |",
		"| `requirements` |",
		"| `tasks` |",
		"| `acceptance` |",
		"| `deliverables` |",
		"| `filing` |",
		"| `workflows` |",
		"| `sprints` |",
		// 两类最容易误读的资源。
		"Template decides visibility",
		"`project resource list` is **not** the archive or the asset tab",
		"`issue list --project` returns requirements *and* tasks",
	}
	for _, want := range mustContain {
		if !strings.Contains(body, want) {
			t.Errorf("project-tabs skill missing %q", want)
		}
	}
}

// TestModulePrototypeRefineSkillPinsTheBoundedWorkflow 锁死这条技能存在的理由：
// 「只改指定功能模块」不是语气问题，而是四个可执行动作缺一不可 ——
// ①一次取全模块上下文；②把当前原型源码落盘（html_path 只是坐标，磁盘上常常没有文件）；
// ③上传后用 prototype diff 证明改动没有溢出目标锚点；④验收引用 coverage 与
// fp.<code>.acceptance，而不是「应该没问题」。任何一条被删掉，agent 就会退回
// 「顺手把别的也改一下」和「改完了」这两种失败模式。
func TestModulePrototypeRefineSkillPinsTheBoundedWorkflow(t *testing.T) {
	skill, ok := findSkill(t, "multica-module-prototype-refine")
	if !ok {
		return
	}
	fm, body, ok := splitFrontmatter(skill.Content)
	if !ok {
		t.Fatalf("SKILL.md must lead with a --- frontmatter block")
	}

	if got := strings.TrimSpace(fm["user-invocable"]); got != "false" {
		t.Errorf("user-invocable = %q, want false (this triggers from a refinement request, not a slash command)", got)
	}
	if got := strings.TrimSpace(fm["allowed-tools"]); got != "Bash(multica *)" {
		t.Errorf("allowed-tools = %q, want Bash(multica *) (every step is a multica CLI call)", got)
	}

	// Each entry is a step the contract cannot lose; the exact flags are what the
	// CLI actually accepts today, so a renamed flag breaks here, not in the field.
	mustContain := []string{
		"multica module context <module> --output json",
		"multica module prototype read <module> --version <n> --out .refine/prototype-v<n>.html",
		"multica module prototype upload <module> --file .refine/prototype-v<n>.html",
		"multica module prototype diff <module> --from <n> --to <n+1>",
		"multica module coverage <module> --output json",
		"multica module brief patch <module> --base-version <v> --source agent",
	}
	for _, want := range mustContain {
		if !strings.Contains(body, want) {
			t.Errorf("skill body is missing the step %q", want)
		}
	}

	// The boundary proof and the anchor contract are the two sentences that make
	// "only this module" checkable rather than aspirational.
	mustExplain := []string{"subset", "data-fp", "canonical"}
	for _, want := range mustExplain {
		if !strings.Contains(body, want) {
			t.Errorf("skill body never mentions %q", want)
		}
	}
}

func findSkill(t *testing.T, name string) (AgentSkillData, bool) {
	t.Helper()
	for _, s := range loadBuiltinSkills() {
		if s.Name == name {
			return s, true
		}
	}
	t.Errorf("built-in skill %q not found", name)
	return AgentSkillData{}, false
}

func skillHasFile(skill AgentSkillData, path string) bool {
	for _, f := range skill.Files {
		if f.Path == path {
			return true
		}
	}
	return false
}

// splitFrontmatter returns the top-level scalar keys of a leading YAML
// frontmatter block, the body after it, and whether a block was found. It only
// understands flat `key: value` lines — enough for the template's frontmatter.
func splitFrontmatter(content string) (map[string]string, string, bool) {
	if !strings.HasPrefix(content, "---\n") {
		return nil, content, false
	}
	rest := content[len("---\n"):]
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return nil, content, false
	}
	block := rest[:end]
	body := rest[end:]
	if nl := strings.Index(body, "\n"); nl >= 0 {
		body = body[nl+1:] // drop the closing --- line
	}

	fm := make(map[string]string)
	for _, line := range strings.Split(block, "\n") {
		if strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t") {
			continue // nested value; the template uses only flat scalars
		}
		key, val, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		fm[strings.TrimSpace(key)] = strings.Trim(strings.TrimSpace(val), `"'`)
	}
	return fm, body, true
}

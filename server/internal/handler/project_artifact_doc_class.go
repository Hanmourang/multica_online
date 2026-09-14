package handler

import (
	"path/filepath"
	"strings"
)

var knownDocClasses = map[string]bool{
	"prd": true, "mrd": true, "brd": true, "roadmap": true,
}

func normalizeDocClass(explicit, docType, relPath string) string {
	c := strings.ToLower(strings.TrimSpace(explicit))
	if knownDocClasses[c] {
		return c
	}
	base := strings.ToLower(filepath.Base(filepath.ToSlash(relPath)))
	name := strings.TrimSuffix(strings.TrimSuffix(base, ".md"), ".html")
	if name == "prd" || strings.HasPrefix(name, "prd-") || name == "requirement" {
		return "prd"
	}
	if name == "mrd" || strings.HasPrefix(name, "mrd-") {
		return "mrd"
	}
	if name == "brd" || strings.HasPrefix(name, "brd-") {
		return "brd"
	}
	if docType == "requirement" {
		return "prd"
	}
	if docType == "work-plan" {
		return "roadmap"
	}
	return ""
}

func docClassPtr(explicit *string, docType, relPath string) *string {
	value := ""
	if explicit != nil {
		value = *explicit
	}
	got := normalizeDocClass(value, docType, relPath)
	if got == "" {
		return nil
	}
	return &got
}

func isPlanningDocClass(class string) bool {
	return class == "prd" || class == "mrd" || class == "brd" || class == "roadmap"
}

func normalizeDocModule(value string) string {
	s := strings.TrimSpace(strings.ReplaceAll(value, "\\", "/"))
	if i := strings.LastIndex(s, "/"); i >= 0 {
		s = strings.TrimSpace(s[i+1:])
	}
	if len(s) > 64 {
		s = strings.TrimSpace(s[:64])
	}
	return s
}

func normalizeDocModulePtr(explicit *string) *string {
	if explicit == nil {
		return nil
	}
	got := normalizeDocModule(*explicit)
	if got == "" {
		return nil
	}
	return &got
}

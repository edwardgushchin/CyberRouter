package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRejectInvalidProviderTargets(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.json")
	for _, text := range []string{
		`{"provider":"vk","link":"https://attacker.invalid/call/join/test"}`,
		`{"provider":"telemost","link":"https://telemost.yandex.ru/j/test","fps":-1}`,
		`{"provider":"unknown","link":"https://telemost.yandex.ru/j/test"}`,
		`{"provider":"telemost","link":"https://user:password@telemost.yandex.ru/j/test"}`,
	} {
		if err := os.WriteFile(p, []byte(text), 0600); err != nil { t.Fatal(err) }
		if _, err := loadConfig(p); err == nil { t.Fatal("accepted invalid config") }
	}
	if err := os.WriteFile(p, []byte(`{"provider":"telemost","link":"https://telemost.yandex.ru/j/test"}`), 0600); err != nil { t.Fatal(err) }
	if _, err := loadConfig(p); err != nil { t.Fatal(err) }
}

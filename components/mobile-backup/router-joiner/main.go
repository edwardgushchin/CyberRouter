// Router entry point for the unmodified whitelist-bypass relay packages at commit 89d7a47.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"strings"
	"syscall"
	"time"

	"github.com/pion/webrtc/v4"
	"whitelist-bypass/relay/common"
	"whitelist-bypass/relay/pion"
	joiner "whitelist-bypass/relay/pion/headless-joiner-common"
	"whitelist-bypass/relay/tunnel"
	"whitelist-bypass/relay/wbstream"
)

type config struct {
	Provider string `json:"provider"`
	Link string `json:"link"`
	Mode string `json:"mode"`
	FPS int `json:"fps"`
	Batch int `json:"batch"`
}

func loadConfig(path string) (config, error) {
	var c config
	b, err := os.ReadFile(path)
	if err != nil { return c, errors.New("cannot read config") }
	if json.Unmarshal(b, &c) != nil { return c, errors.New("invalid config JSON") }
	u, err := url.Parse(c.Link)
	if err != nil || u.User != nil || u.Fragment != "" { return c, errors.New("invalid link") }
	ok := false
	switch c.Provider {
	case "telemost": ok = u.Scheme == "https" && u.Host == "telemost.yandex.ru" && strings.HasPrefix(u.Path, "/j/")
	case "vk": ok = u.Scheme == "https" && (u.Host == "vk.com" || u.Host == "vk.ru") && strings.HasPrefix(u.Path, "/call/join/")
	case "wbstream": ok = (u.Scheme == "wbstream" && u.Host != "") || (u.Scheme == "https" && u.Host == "stream.wb.ru" && strings.HasPrefix(u.Path, "/room/"))
	}
	if !ok { return c, errors.New("provider/link mismatch") }
	if c.Mode == "" { c.Mode = "video" }
	if c.Mode != "video" && c.Mode != "dc" { return c, errors.New("invalid mode") }
	if c.FPS == 0 { c.FPS = 24 }
	if c.Batch == 0 { c.Batch = 30 }
	if c.FPS < 1 || c.FPS > 60 || c.Batch < 1 || c.Batch > 120 { return c, errors.New("invalid pacing") }
	return c, nil
}

// Upstream debug messages can contain call links and auth tokens. Emit only
// fixed state names; operational health is determined by actual proxy requests.
func quiet(string, ...any) {}
type status struct { dir string }
func (s status) EmitStatus(value string) {
	if strings.HasPrefix(value, "CAPTCHA:") {
		u, err := url.Parse(strings.TrimPrefix(value, "CAPTCHA:"))
		if err == nil && u.Hostname() == "127.0.0.1" {
			_ = os.WriteFile(filepath.Join(s.dir, "captcha-port"), []byte(u.Port()), 0600)
			serveCaptcha(u.Port())
			log.Print("captcha_required")
		}
		return
	}
	if value == "Auth complete" {
		_ = os.Remove(filepath.Join(s.dir, "captcha-port"))
		closeCaptcha()
	}
	for _, allowed := range []string{"CONNECTED", "CONNECTING", "RECONNECTING", "TUNNEL_LOST", "DISCONNECTED"} {
		if value == allowed { log.Print(strings.ToLower(value)) }
	}
}
func (s status) EmitStatusError(value string) {
	if strings.Contains(strings.ToLower(value), "auth") {
		_ = os.Remove(filepath.Join(s.dir, "vk-auth.json"))
		log.Print("authentication_failed")
	} else { log.Print("connection_failed") }
}

type networkConfig string
func (n networkConfig) ConfigureSettingEngine(s *webrtc.SettingEngine) {
	s.SetInterfaceFilter(func(name string) bool { return name == string(n) })
	s.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4, webrtc.NetworkTypeTCP4})
}
type client interface {
	RunWithParams(string)
	MarkConfigAcked()
	Close()
}

func main() {
	path := flag.String("config", "", "protected provider config")
	dns := flag.String("dns", "", "bootstrap DNS IP:port")
	iface := flag.String("interface", "", "mobile uplink interface")
	port := flag.Int("port", 10981, "loopback SOCKS port")
	check := flag.Bool("check", false, "validate configuration and exit")
	authorize := flag.Bool("authorize-vk", false, "refresh VK authorization without starting a tunnel")
	probe := flag.String("probe-socks", "", "verify UDP DNS through a loopback SOCKS endpoint")
	flag.Parse()
	if *probe != "" {
		if err := probeUDP(*probe); err != nil { log.Fatal(err) }
		fmt.Println("udp_dns_ok"); return
	}
	c, err := loadConfig(*path)
	if err != nil { log.Fatal(err) }
	if *check { fmt.Println("configuration_ok"); return }
	if *port < 1024 || *port > 65535 { log.Fatal("invalid port") }
	if _, err := net.InterfaceByName(*iface); err != nil { log.Fatal("invalid interface") }
	host, _, err := net.SplitHostPort(*dns)
	if err != nil || net.ParseIP(host) == nil { log.Fatal("invalid bootstrap DNS") }
	debug.SetMemoryLimit(128 << 20)
	common.Debug = false
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 6*time.Second}).DialContext(ctx, network, *dns)
	}}
	resolve := func(host string) (string, error) {
		if ip := net.ParseIP(host); ip != nil { return host, nil }
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second); defer cancel()
		ips, err := net.DefaultResolver.LookupIP(ctx, "ip4", host)
		if err != nil || len(ips) == 0 { return "", errors.New("bootstrap DNS failed") }
		return ips[0].String(), nil
	}
	st := status{filepath.Dir(*path)}
	if *authorize {
		if c.Provider != "vk" { log.Fatal("VK configuration required") }
		if err := authorizeVK(c, st, resolve); err != nil { log.Fatal("vk_auth_failed") }
		return
	}
	connected := func(ack func()) func(tunnel.DataTunnel) {
		return func(t tunnel.DataTunnel) {
			readBuf := common.VP8BufSize
			switch t.(type) { case *tunnel.DCTunnel, *tunnel.MultiTrackKCPTunnel: readBuf = common.DCBufSize }
			bridge := tunnel.NewRelayBridgeWithAuth(t, "joiner", readBuf, quiet, "", "")
			bridge.SetOnConfigAck(ack)
			bridge.MarkReady()
			go func() {
				if bridge.ListenSOCKS(fmt.Sprintf("127.0.0.1:%d", *port)) != nil {
					log.Print("listener_closed")
					os.Exit(1) // Recreate the listener with a fresh process after reconnect.
				}
			}()
			log.Print("tunnel_connected")
		}
	}
	params := map[string]any{"joinLink": c.Link, "displayName": "Router", "tunnelMode": c.Mode, "vp8Fps": c.FPS, "vp8Batch": c.Batch}
	var inner client
	switch c.Provider {
	case "telemost":
		j := joiner.NewTelemostHeadlessJoiner(quiet, resolve, st, networkConfig(*iface), pion.AddTunnelTracks, pion.ReadTrack)
		j.OnConnected = connected(j.MarkConfigAcked); inner = j
	case "wbstream":
		j := joiner.NewWBStreamHeadlessJoiner(quiet, resolve, st, networkConfig(*iface))
		j.OnConnected = connected(j.MarkConfigAcked); inner = j
		params["roomId"] = wbstream.ParseRoomID(c.Link)
	case "vk":
		cache := filepath.Join(st.dir, "vk-auth.json")
		auth, _ := os.ReadFile(cache)
		if len(auth) == 0 { log.Fatal("authentication_required") }
		var vkParams map[string]any
		if json.Unmarshal(auth, &vkParams) != nil { log.Fatal("invalid_auth_cache") }
		for k, v := range vkParams { params[k] = v }
		j := joiner.NewVKHeadlessJoiner(quiet, resolve, st, networkConfig(*iface), pion.AddTunnelTracks, pion.ReadTrack)
		j.OnConnected = connected(j.MarkConfigAcked); inner = j
	}
	raw, _ := json.Marshal(params)
	go inner.RunWithParams(string(raw))
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	inner.Close()
}

// Authorization has its own procd service: changing transport must not close CAPTCHA.
func authorizeVK(c config, st status, resolve joiner.ResolveFunc) error {
	statePath := filepath.Join(st.dir, "auth-state")
	_ = os.Remove(filepath.Join(st.dir, "captcha-port"))
	_ = os.WriteFile(statePath, []byte("pending"), 0600)
	defer func() { _ = os.Remove(filepath.Join(st.dir, "captcha-port")); closeCaptcha() }()
	value, err := joiner.RunVKAuth(c.Link, "Router", quiet, st.EmitStatus, nil, resolve)
	if err != nil { _ = os.WriteFile(statePath, []byte("error"), 0600); return errors.New("VK authorization failed") }
	cache := filepath.Join(st.dir, "vk-auth.json")
	if err := os.WriteFile(cache+".new", []byte(value), 0600); err != nil { return err }
	if err := os.Rename(cache+".new", cache); err != nil { return err }
	_ = os.WriteFile(statePath, []byte("ready"), 0600)
	log.Print("authentication_saved")
	return nil
}

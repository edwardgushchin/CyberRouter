package joiner

import (
	"sync"
	"time"

	"whitelist-bypass/relay/tunnel"
)

const configResendPeriod = 3 * time.Second

type configAckTracker struct {
	mu        sync.Mutex
	acked     chan struct{}
	cancel    chan struct{}
	confirmed bool
}

func (t *configAckTracker) acknowledged() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.confirmed
}

func (t *configAckTracker) arm() (acked, cancel chan struct{}) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.cancel != nil {
		close(t.cancel)
	}
	t.acked = make(chan struct{})
	t.cancel = make(chan struct{})
	return t.acked, t.cancel
}

func (t *configAckTracker) mark() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.confirmed = true
	if t.acked == nil {
		return
	}
	select {
	case <-t.acked:
	default:
		close(t.acked)
	}
}

func sendVP8ConfigUntilAcked(acked, cancel <-chan struct{}, stopCh <-chan struct{}, tun tunnel.DataTunnel, fps, batch, trackCount int, logFn func(string, ...any), logPrefix string) {
	tun.SendData(tunnel.EncodeVP8Config(fps, batch, trackCount))
	ticker := time.NewTicker(configResendPeriod)
	defer ticker.Stop()
	for {
		select {
		case <-acked:
			return
		case <-cancel:
			return
		case <-stopCh:
			return
		case <-ticker.C:
			logFn("%s: resending vp8 config fps=%d batch=%d trackCount=%d, no ack yet",
				logPrefix, fps, batch, trackCount)
			tun.SendData(tunnel.EncodeVP8Config(fps, batch, trackCount))
		}
	}
}

package joiner

import (
	"time"

	"whitelist-bypass/relay/common"
)

const (
	reconnectInitialDelay = time.Second
	reconnectMaxDelay     = 16 * time.Second
)

func waitReconnectBackoff(attempt int, logFn func(string, ...any), logPrefix string, stopCh <-chan struct{}, isClosed func() bool) bool {
	delay := common.BackoffWithJitter(attempt, reconnectInitialDelay, reconnectMaxDelay)
	logFn("%s: waiting %s before reconnect", logPrefix, delay)
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return !isClosed()
	case <-stopCh:
		return false
	}
}

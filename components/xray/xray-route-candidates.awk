function request_id(line, rest, token) {
	rest = line
	token = ""
	while (match(rest, /\[[0-9][0-9]*\]/)) {
		token = substr(rest, RSTART + 1, RLENGTH - 2)
		rest = substr(rest, RSTART + RLENGTH)
	}
	# logread prefixes xray[PID]; the final numeric bracket is the request ID.
	return token
}

function forget(id) {
	delete is_tproxy[id]
}

function remember_tproxy(id, slot, old_id) {
	sequence++
	slot = (sequence % 512) + 1
	old_id = slot_id[slot]
	if (old_id != "")
		forget(old_id)
	slot_id[slot] = id
	is_tproxy[id] = 1
}

function submit_candidate(domain, command) {
	if (candidate_command == "") {
		print domain
		fflush()
		return
	}

	command = candidate_command " " domain " >/dev/null 2>&1"
	system(command)
}

BEGIN {
	live_stream = (start_marker == "")
}

!live_stream {
	if (index($0, start_marker) > 0)
		live_stream = 1
	next
}

/proxy\/dokodemo: received request/ {
	id = request_id($0)
	if (id != "")
		remember_tproxy(id)
	next
}

/app\/dispatcher: taking detour \[direct\] for \[(tcp|udp):/ {
	id = request_id($0)
	if (id == "" || !is_tproxy[id])
		next

	destination = $0
	sub(/^.*for \[(tcp|udp):/, "", destination)
	sub(/\].*$/, "", destination)
	if (destination !~ /:443$/)
		next

	sub(/:443$/, "", destination)
	destination = tolower(destination)
	sub(/\.$/, "", destination)

	if (destination !~ /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/ || \
	    destination !~ /[a-z]/ || destination !~ /\./)
		next

	if (destination ~ /\.(lan|local)$/ || destination == "home.arpa" || \
	    destination ~ /\.home\.arpa$/)
		next

	# The worker checks its persistent cooldown and verifies direct/proxy paths.
	# ponytail: one worker serializes probes; add a bounded queue only if measured
	# log backlog causes missed domains. Never spawn a process per connection.
	submit_candidate(destination)
	forget(id)
}

# LiveKit config TEMPLATE — rendered on the box by render-config.sh (ExecStartPre of
# harvester-livekit.container): __LIVEKIT_API_SECRET__ is replaced from the podman
# secret store and the result lands on the user's tmpfs runtime dir. Never contains
# the real secret in git or on persistent disk.
# The key name (`harvester`) must match LIVEKIT_API_KEY in harvester.env + egress.yaml.tpl.
port: 7880
bind_addresses:
  - ""
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50099
  use_external_ip: false
redis:
  address: harvester-redis:6379
keys:
  harvester: __LIVEKIT_API_SECRET__
room:
  auto_create: true
  # backstop: a room with both parties gone dies after 15 minutes; the session id keys
  # everything, so a recreated room is normal, not an error
  empty_timeout: 900
webhook:
  api_key: harvester
  urls:
    - http://harvester-app:4747/api/call/webhook
logging:
  level: info

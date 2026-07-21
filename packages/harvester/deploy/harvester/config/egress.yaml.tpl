# Egress config TEMPLATE — rendered on the box by render-config.sh (ExecStartPre of
# harvester-egress.container), same mechanism as livekit.yaml.tpl. api_key/api_secret
# must match livekit.yaml.tpl and harvester.env's LIVEKIT_API_KEY.
redis:
  address: harvester-redis:6379
api_key: harvester
api_secret: __LIVEKIT_API_SECRET__
ws_url: ws://harvester-livekit:7880
insecure: true
logging:
  level: info

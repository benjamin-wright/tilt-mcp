# Root Tiltfile — development testbed for tilt-mcp.
# Run `tilt up` from the project root to start a local session.

local_resource(
    'always-succeeds',
    cmd='echo "build ok"',
    labels=['examples'],
)

local_resource(
    'always-fails-build',
    cmd='sh -c "echo \\"build failed\\" >&2; exit 1"',
    labels=['examples'],
)

local_resource(
    'always-fails-runtime',
    cmd='echo "build ok"',
    serve_cmd='sh -c "echo \\"runtime failure\\" >&2; exit 1"',
    labels=['examples'],
)

local_resource(
  'hangs-for-a-while',
  cmd='sh -c "echo \\"running...\\"; sleep 30; echo \\"build ok\\""',
  labels=['examples'],
)

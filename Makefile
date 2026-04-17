IMAGE := benwright/tilt-mcp
TAG   := v0.0.5

.PHONY: build push test

build:
	docker build -t $(IMAGE):$(TAG) .

push: build
	docker push $(IMAGE):$(TAG)

test:
	npm run test:integration

IMAGE := benjaminwright/tilt-mcp
TAG   := latest

.PHONY: build push test

build:
	docker build -t $(IMAGE):$(TAG) .

push: build
	docker push $(IMAGE):$(TAG)

test:
	npm run test:integration

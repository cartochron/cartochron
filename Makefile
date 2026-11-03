all: vendor

vendor:
	python3 vendor_leaflet.py

check:
	python3 -m unittest discover -s tests -v
	node --test tests/test_viewer.cjs

check-viewer:
	node --test tests/test_viewer.cjs

# Real Docker integration; explicit because it builds an image and starts containers.
check-deploy:
	python3 -m unittest discover -s tests -p 'deployment_check.py' -v


clean:
	rm -rf vendor

.PHONY: all vendor check check-viewer check-deploy clean

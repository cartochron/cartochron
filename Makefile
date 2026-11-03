MSF_DIR ?= $(HOME)/.msf4/modules

all: vendor

vendor:
	python3 vendor_leaflet.py

check:
	python3 -m unittest discover -s tests -v
	ruby tests/test_gps_streamer.rb
	node --test tests/test_viewer.cjs

check-viewer:
	node --test tests/test_viewer.cjs

# Real Docker integration; explicit because it builds an image and starts containers.
check-deploy:
	python3 -m unittest discover -s tests -p 'deployment_check.py' -v

install-local:
	install -m 0644 gps_streamer.rb \
		-D "$(MSF_DIR)/post/android/gather/gps_streamer.rb"

uninstall-local:
	rm -f "$(MSF_DIR)/post/android/gather/gps_streamer.rb"

clean:
	rm -rf vendor

.PHONY: all vendor check check-viewer check-deploy install-local uninstall-local clean

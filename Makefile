MSF_DIR ?= $(HOME)/.msf4/modules

all: vendor

vendor:
	python3 vendor_leaflet.py

check:
	python3 -m unittest discover -s tests -v
	ruby tests/test_gps_streamer.rb
	@if command -v node >/dev/null 2>&1; then \
		node --test tests/test_viewer.cjs; \
	else \
		echo 'SKIP viewer tests: Node.js not installed (optional: make check-viewer)'; \
	fi

check-viewer:
	node --test tests/test_viewer.cjs

install-local:
	install -m 0644 gps_streamer.rb \
		-D ~/.msf4/modules/post/android/gather/gps_streamer.rb

uninstall-local:
	rm -f ~/.msf4/modules/post/android/gather/gps_streamer.rb

clean:
	rm -rf vendor

.PHONY: all vendor check check-viewer install-local uninstall-local clean

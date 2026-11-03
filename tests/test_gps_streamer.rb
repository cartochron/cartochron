# Exercise the HTTP transport without requiring an Android session or Metasploit.
require 'minitest/autorun'
require 'net/http'
require 'json'
require 'uri'

module Msf
  class Post
    module Android
      module System; end
    end
  end
end

require_relative '../gps_streamer'

class GPSStreamerTest < Minitest::Test
  class Recorder
    attr_accessor :use_ssl, :open_timeout, :read_timeout
    attr_reader :request_sent

    def request(request)
      @request_sent = request
      Net::HTTPCreated.new('1.1', '201', 'Created')
    end
  end

  def setup
    @module = MetasploitModule.allocate
    @http = Recorder.new
  end

  def test_https_with_basic_auth
    Net::HTTP.stub(:new, @http) do
      @module.submit_position(URI('https://map.example.test:9443/api/position'),
                              47.0, 28.0, 'operator', 'private-password')
    end
    assert_equal true, @http.use_ssl
    assert_equal 5, @http.open_timeout
    assert_equal 5, @http.read_timeout
    assert_equal '/api/position', @http.request_sent.path
    assert_equal 'application/json', @http.request_sent['Content-Type']
    assert_equal 'Basic ' + ['operator:private-password'].pack('m0'),
                 @http.request_sent['Authorization']
    assert_equal({ 'lat' => 47.0, 'lon' => 28.0 }, JSON.parse(@http.request_sent.body))
  end

  def test_track_id_is_transmitted_with_observation
    Net::HTTP.stub(:new, @http) do
      @module.submit_position(URI('http://127.0.0.1:8765/api/position'),
                              47.0, 28.0, '', '', 'lab-run-1')
    end
    assert_equal({ 'lat' => 47.0, 'lon' => 28.0, 'track_id' => 'lab-run-1' },
                 JSON.parse(@http.request_sent.body))
  end

  def test_source_id_is_optional_and_sent_as_protocol_field
    source = 'src_' + 'c' * 24
    Net::HTTP.stub(:new, @http) do
      @module.submit_position(URI('https://map.example.test/api/position'),
                              47.0, 28.0, '', '', 'run-a', source)
    end
    assert_equal source, JSON.parse(@http.request_sent.body)['source_id']
    assert_equal 'run-a', JSON.parse(@http.request_sent.body)['track_id']
  end

  def test_enrolled_source_reused_across_jobs_with_distinct_runs
    success = Net::HTTPCreated.new('1.1', '201', 'Created')
    source = 'src_' + 'a' * 24
    first, _, _ = streamer_fixture([success], settings: {'SOURCE_ID' => source})
    assert_raises(Interrupt) { @module.run }
    second, _, _ = streamer_fixture([success], settings: {'SOURCE_ID' => source})
    assert_raises(Interrupt) { @module.run }
    refute_equal first.first, second.first
  end

  def test_invalid_source_id_fails_before_streaming
    _sent, _logs, console = streamer_fixture([], settings: {'SOURCE_ID' => 'invalid'})
    @module.run
    assert console.any? { |line| line.include?('SOURCE_ID') }
  end

  def streamer_fixture(responses, positions: nil, interval: 5, settings: {})
    positions ||= Array.new(responses.size) { [{ 'lat' => 47.7548547, 'long' => 27.888729 }] }
    gps = Object.new
    calls = 0
    phone = Struct.new(:android).new(gps)
    datastore = { 'INTERVAL' => interval, 'ENDPOINT' => 'http://127.0.0.1:8765/api/position',
                  'API_KEY' => '', 'MAP_USER' => '', 'MAP_PASSWORD' => '', 'TRACK_ID' => '', 'SOURCE_ID' => '' }.merge(settings)
    sent = []
    logs = []
    console = []
    @module.define_singleton_method(:datastore) { datastore }
    @module.define_singleton_method(:client) { phone }
    @module.define_singleton_method(:ilog) { |message| logs << [:info, message] }
    @module.define_singleton_method(:wlog) { |message| logs << [:warn, message] }
    @module.define_singleton_method(:elog) { |message| logs << [:error, message] }
    @module.define_singleton_method(:dlog) { |message, source, level| logs << [:debug, message, source, level] }
    @module.define_singleton_method(:print_good) { |message| console << message }
    @module.define_singleton_method(:print_status) { |message| console << message }
    @module.define_singleton_method(:print_error) { |message| console << message }
    @module.define_singleton_method(:submit_position) do |_uri, _lat, _lon, _user, _password, track, _source|
      sent << track
      response = responses.fetch(calls - 1)
      raise response if response.is_a?(Exception)
      response
    end
    @module.define_singleton_method(:sleep) do |_delay|
      raise Interrupt if calls >= positions.size
    end
    # Advance once per geolocation call, so the next scripted response is used.
    gps.define_singleton_method(:geolocate) do
      calls += 1
      positions.fetch(calls - 1)
    end
    [sent, logs, console]
  end

  def test_background_run_logs_transitions_not_each_fix_to_console
    success = Net::HTTPCreated.new('1.1', '201', 'Created')
    sent, logs, console = streamer_fixture([success] * 3)
    assert_raises(Interrupt) { @module.run }
    assert_equal [], console
    assert_equal 3, sent.length
    assert_equal sent.first, sent.last
    assert_match(/\A[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\z/, sent.first)
    assert_equal 1, logs.count { |kind, msg| kind == :info && msg.include?('Ingestion established') }
    assert_equal 3, logs.count { |kind, _| kind == :debug }
    assert logs.any? { |kind, msg| kind == :info && msg.include?('accepted=3') && msg.include?('Stopped') }
    refute_match(/47\.7548547|27\.888729/, logs.inspect)
  end

  def test_repeated_rejections_are_logged_once_and_recovery_is_visible
    denied = Net::HTTPUnauthorized.new('1.1', '401', 'Unauthorized')
    success = Net::HTTPCreated.new('1.1', '201', 'Created')
    _sent, logs, console = streamer_fixture([denied, denied, success])
    assert_raises(Interrupt) { @module.run }
    assert_empty console
    assert_equal 1, logs.count { |kind, msg| kind == :warn && msg.include?('HTTP 401') }
    assert logs.any? { |kind, msg| kind == :info && msg.include?('Ingestion recovered') }
    assert logs.any? { |kind, msg| kind == :info && msg.include?('rejected=2') && msg.include?('accepted=1') }
  end

  def test_no_fix_and_exceptions_are_debounced_and_do_not_log_private_messages
    success = Net::HTTPCreated.new('1.1', '201', 'Created')
    positions = [[], [], [{ 'lat' => 47, 'long' => 28 }], [{ 'lat' => 47, 'long' => 28 }]]
    responses = [success, success, RuntimeError.new('secret-from-library'), success]
    _sent, logs, console = streamer_fixture(responses, positions: positions)
    assert_raises(Interrupt) { @module.run }
    assert_empty console
    assert_equal 1, logs.count { |kind, msg| kind == :warn && msg.include?('No usable location fix') }
    assert_equal 1, logs.count { |kind, msg| kind == :error && msg.include?('type=RuntimeError') }
    refute_match(/secret-from-library/, logs.inspect)
  end

  def test_periodic_progress_uses_elapsed_time_not_poll_count
    success = Net::HTTPCreated.new('1.1', '201', 'Created')
    sent, logs, _console = streamer_fixture([success] * 4)
    clock = 0.0
    @module.define_singleton_method(:sleep) do |_delay|
      clock += 31.0
      raise Interrupt if sent.size >= 4
    end
    Process.stub(:clock_gettime, ->(_clock) { clock }) do
      assert_raises(Interrupt) { @module.run }
    end
    assert_equal 1, logs.count { |kind, msg| kind == :info && msg.include?('Progress') }
    assert logs.any? { |kind, msg| kind == :info && msg.include?('Progress') && msg.include?('accepted=3') }
  end

  def test_http_without_auth_is_backward_compatible
    Net::HTTP.stub(:new, @http) do
      @module.submit_position(URI('http://127.0.0.1:8765/api/position'),
                              47.0, 28.0, '', '')
    end
    assert_equal false, @http.use_ssl
    assert_nil @http.request_sent['Authorization']
  end
end

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

  def test_http_without_auth_is_backward_compatible
    Net::HTTP.stub(:new, @http) do
      @module.submit_position(URI('http://127.0.0.1:8765/api/position'),
                              47.0, 28.0, '', '')
    end
    assert_equal false, @http.use_ssl
    assert_nil @http.request_sent['Authorization']
  end
end

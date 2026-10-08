module {
  func.func @identity(%arg0: i32) -> i32 {
    %zero = arith.constant 0 : i32
    %sum = arith.addi %arg0, %zero : i32
    return %sum : i32
  }
}
